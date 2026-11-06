import './style.css';
import { connectRealtime } from './realtime';
import type { GameCommand, GameState, PlacementMode, PlayerState } from './protocol';

const palette = ['#f2c45f', '#e96d5f', '#75c9bc', '#8da9e8'] as const;

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

const connectionDot = requireElement('connection-dot');
const connectionLabel = requireElement('connection-label');
const offlineNotice = requireElement('controller-offline');
const playersList = requireElement('controls-players');
const buildStatus = requireElement('build-status');
const rollStatus = requireElement('roll-status');
const boardSeed = requireElement('board-seed');
const editPlayersButton = requireElement<HTMLButtonElement>('edit-players');
const cancelBuildButton = requireElement<HTMLButtonElement>('cancel-build');
const clearRollButton = requireElement<HTMLButtonElement>('clear-roll');
const newBoardButton = requireElement<HTMLButtonElement>('new-board');
const resetViewButton = requireElement<HTMLButtonElement>('reset-view');
const buildButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-build]'));
const diceButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-roll]'));
const setupDialog = requireElement<HTMLDialogElement>('setup-dialog');
const setupForm = requireElement<HTMLFormElement>('setup-form');
const playerFields = requireElement('player-fields');
const addPlayerButton = requireElement<HTMLButtonElement>('add-player');
const cancelSetupButton = requireElement<HTMLButtonElement>('cancel-setup');

let state: GameState | null = null;
let socketConnected = false;
let boardConnected = false;
let promptedForPlayers = false;

function send(command: GameCommand): void {
  client.send({ type: 'command', command });
}

function scoreFor(playerId: string): number {
  return state?.structures.reduce((score, structure) => score + (structure.ownerId === playerId ? (structure.kind === 'city' ? 2 : 1) : 0), 0) ?? 0;
}

function render(): void {
  const usable = socketConnected && boardConnected && state !== null;
  offlineNotice.classList.toggle('controller-notice--hidden', boardConnected);
  playersList.replaceChildren();

  if (!state?.players.length) {
    const empty = document.createElement('p');
    empty.className = 'controller-empty';
    empty.textContent = usable ? 'Add players to begin.' : 'Waiting for the board state…';
    playersList.append(empty);
  } else {
    const currentState = state;
    currentState.players.forEach((player, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `controller-player${index === currentState.activePlayerIndex ? ' controller-player--active' : ''}`;
      button.style.setProperty('--player-color', palette[player.colorIndex] ?? palette[0]);
      button.disabled = !usable || currentState.robberPlacementPending;
      button.setAttribute('aria-pressed', String(index === currentState.activePlayerIndex));
      const dot = document.createElement('span'); dot.className = 'controller-player__dot';
      const name = document.createElement('strong'); name.textContent = player.name;
      const score = document.createElement('span'); score.textContent = `${scoreFor(player.id)} VP`;
      button.append(dot, name, score);
      button.addEventListener('click', () => send({ type: 'player:select', index }));
      playersList.append(button);
    });
  }

  const controlsLocked = !usable || !state?.players.length || !!state?.robberPlacementPending;
  buildButtons.forEach((button) => {
    button.disabled = controlsLocked;
    button.setAttribute('aria-pressed', String(button.dataset.build === state?.placementMode));
  });
  cancelBuildButton.hidden = !state?.placementMode;
  cancelBuildButton.disabled = controlsLocked;
  diceButtons.forEach((button) => {
    button.disabled = !usable || !!state?.robberPlacementPending;
    button.setAttribute('aria-pressed', String(Number(button.dataset.roll) === state?.lastRoll));
  });
  clearRollButton.disabled = !usable || state?.lastRoll === null;
  clearRollButton.textContent = state?.robberPlacementPending ? 'Cancel' : 'Clear';
  clearRollButton.setAttribute('aria-label', state?.robberPlacementPending ? 'Cancel robber move' : 'Clear dice roll');
  editPlayersButton.disabled = !usable || !!state?.robberPlacementPending;
  newBoardButton.disabled = !usable || !!state?.robberPlacementPending;
  resetViewButton.disabled = !usable;
  buildStatus.textContent = state?.buildStatus ?? 'Waiting for the board…';
  rollStatus.textContent = state?.rollStatus ?? 'Choose a roll';
  rollStatus.classList.toggle('roll-status--urgent', !!state?.robberPlacementPending);
  boardSeed.textContent = state?.island.id ?? '—';
}

function updateConnection(): void {
  const ready = socketConnected && boardConnected;
  connectionDot.classList.toggle('connection-dot--online', ready);
  connectionLabel.textContent = !socketConnected ? 'Reconnecting' : boardConnected ? 'Board online' : 'Waiting for board';
  render();
}

function addPlayerField(player?: PlayerState): void {
  if (playerFields.children.length >= 4) return;
  const index = playerFields.children.length;
  const row = document.createElement('div');
  row.className = 'player-field';
  row.dataset.playerId = player?.id ?? '';
  row.style.setProperty('--player-color', palette[index]);
  const number = document.createElement('span'); number.className = 'player-field__number'; number.textContent = String(index + 1);
  const input = document.createElement('input'); input.name = 'player-name'; input.value = player?.name ?? ''; input.placeholder = `Player ${index + 1}`; input.maxLength = 24; input.required = true; input.autocomplete = 'off';
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-player'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove player ${index + 1}`);
  remove.addEventListener('click', () => { if (playerFields.children.length > 2) { row.remove(); normalizePlayerFields(); } });
  row.append(number, input, remove);
  playerFields.append(row);
  normalizePlayerFields();
}

function normalizePlayerFields(): void {
  Array.from(playerFields.children).forEach((child, index) => {
    const row = child as HTMLDivElement;
    row.style.setProperty('--player-color', palette[index]);
    row.querySelector('.player-field__number')!.textContent = String(index + 1);
    row.querySelector<HTMLButtonElement>('.remove-player')!.hidden = playerFields.children.length <= 2;
  });
  addPlayerButton.hidden = playerFields.children.length >= 4;
}

function openSetup(): void {
  playerFields.replaceChildren();
  if (state?.players.length) state.players.forEach((player) => addPlayerField(player));
  else { addPlayerField(); addPlayerField(); }
  cancelSetupButton.hidden = !state?.players.length;
  setupDialog.showModal();
  window.setTimeout(() => playerFields.querySelector<HTMLInputElement>('input')?.focus(), 50);
}

setupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const players = Array.from(playerFields.querySelectorAll<HTMLDivElement>('.player-field')).map((row, index) => ({
    id: row.dataset.playerId || crypto.randomUUID().slice(0, 8),
    name: row.querySelector<HTMLInputElement>('input')!.value.trim(),
    colorIndex: index,
  }));
  if (players.some((player) => !player.name)) return;
  send({ type: 'players:set', players });
  setupDialog.close();
});
setupDialog.addEventListener('cancel', (event) => { if (!state?.players.length) event.preventDefault(); });
editPlayersButton.addEventListener('click', openSetup);
addPlayerButton.addEventListener('click', () => addPlayerField());
cancelSetupButton.addEventListener('click', () => setupDialog.close());
buildButtons.forEach((button) => button.addEventListener('click', () => send({ type: 'build:set', mode: button.dataset.build as Exclude<PlacementMode, null> })));
cancelBuildButton.addEventListener('click', () => send({ type: 'build:set', mode: null }));
diceButtons.forEach((button) => button.addEventListener('click', () => send({ type: 'roll:set', total: Number(button.dataset.roll) })));
clearRollButton.addEventListener('click', () => send({ type: 'roll:clear' }));
resetViewButton.addEventListener('click', () => send({ type: 'view:reset' }));
newBoardButton.addEventListener('click', () => { if (window.confirm('Create a new island and clear all placed pieces?')) send({ type: 'island:new' }); });

const client = connectRealtime({
  role: 'controls',
  onConnectionChange(connected) { socketConnected = connected; updateConnection(); },
  onMessage(message) {
    if (message.type === 'presence') { boardConnected = message.boards > 0; updateConnection(); }
    if (message.type === 'state') {
      state = message.state;
      render();
      if (!state.players.length && !promptedForPlayers) { promptedForPlayers = true; openSetup(); }
    }
  },
});

render();
