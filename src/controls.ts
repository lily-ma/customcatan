import './style.css';
import { Application, Circle, Container, Graphics, Polygon, Rectangle, Text } from 'pixi.js';
import { connectRealtime } from './realtime';
import type { GameCommand, GameState, PlacementMode, PlacementTarget, PlayerState } from './protocol';

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
const clearRollLabel = requireElement('clear-roll-label');
const newBoardButton = requireElement<HTMLButtonElement>('new-board');
const resetViewButton = requireElement<HTMLButtonElement>('reset-view');
const playKnightButton = requireElement<HTMLButtonElement>('play-knight');
const knightCardPlayer = requireElement('knight-card-player');
const makeAdjustmentsButton = requireElement<HTMLButtonElement>('make-adjustments');
const knightsList = requireElement('knights-list');
const buildButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-build]'));
const diceButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-roll]'));
const setupDialog = requireElement<HTMLDialogElement>('setup-dialog');
const setupForm = requireElement<HTMLFormElement>('setup-form');
const playerFields = requireElement('player-fields');
const addPlayerButton = requireElement<HTMLButtonElement>('add-player');
const cancelSetupButton = requireElement<HTMLButtonElement>('cancel-setup');
const placementDialog = requireElement<HTMLDialogElement>('placement-dialog');
const placementViewport = requireElement<HTMLDivElement>('placement-viewport');
const placementLoading = requireElement('placement-loading');
const placementTitle = requireElement('placement-title');
const placementHelp = requireElement('placement-help');
const placementCloseButton = requireElement<HTMLButtonElement>('placement-close');
const adjustmentsDialog = requireElement<HTMLDialogElement>('adjustments-dialog');
const adjustmentsCloseButton = requireElement<HTMLButtonElement>('adjustments-close');

let state: GameState | null = null;
let socketConnected = false;
let boardConnected = false;
let promptedForPlayers = false;
let pendingPlacementMode: Exclude<PlacementMode, null> | null = null;
let pendingRobberSelection = false;
let placementApp: Application | null = null;
let placementWorld: Container | null = null;
let placementInitialization: Promise<void> | null = null;

function send(command: GameCommand): void {
  client.send({ type: 'command', command });
}

function scoreFor(playerId: string): number {
  const structureScore = state?.structures.reduce((score, structure) => score + (structure.ownerId === playerId ? (structure.kind === 'city' ? 2 : 1) : 0), 0) ?? 0;
  return structureScore + (state?.longestRoad?.holderId === playerId ? 2 : 0) + (state?.largestArmy?.holderId === playerId ? 2 : 0);
}

const PLACEMENT_HEX_SIZE = 76;
const placementHexPoints = Array.from({ length: 6 }, (_, index) => {
  const angle = ((index * 60 - 30) * Math.PI) / 180;
  return [Math.cos(angle) * PLACEMENT_HEX_SIZE, Math.sin(angle) * PLACEMENT_HEX_SIZE];
}).flat();
const terrainColors = {
  forest: 0x2f6748,
  pasture: 0x8bbf73,
  fields: 0xe0b84e,
  hills: 0xb96545,
  mountains: 0x748087,
  desert: 0xd4b47a,
} as const;

function axialToPlacementPixel(q: number, r: number): { x: number; y: number } {
  return { x: PLACEMENT_HEX_SIZE * Math.sqrt(3) * (q + r / 2), y: PLACEMENT_HEX_SIZE * 1.5 * r };
}

const resourceIcons = {
  forest: '🌲',
  pasture: '🐑',
  fields: '🌾',
  hills: '🧱',
  mountains: '⛰',
} as const;
type ResourceTerrain = keyof typeof resourceIcons;

function productionSummary(gameState: GameState): string | null {
  if (gameState.lastRoll === null || gameState.lastRoll === 7 || gameState.robberPlacementPending) return null;
  const structuresByVertex = new Map(gameState.structures.map((structure) => [structure.vertexKey, structure]));
  const payouts = new Map<string, Map<ResourceTerrain, number>>();

  gameState.island.hexes.forEach((hex) => {
    if (hex.number !== gameState.lastRoll || hex.terrain === 'desert') return;
    if (hex.q === gameState.island.robber.q && hex.r === gameState.island.robber.r) return;
    const center = axialToPlacementPixel(hex.q, hex.r);
    for (let index = 0; index < placementHexPoints.length; index += 2) {
      const vertexKey = `${Math.round((center.x + placementHexPoints[index]) * 100)},${Math.round((center.y + placementHexPoints[index + 1]) * 100)}`;
      const structure = structuresByVertex.get(vertexKey);
      if (!structure) continue;
      const playerPayout = payouts.get(structure.ownerId) ?? new Map<ResourceTerrain, number>();
      playerPayout.set(hex.terrain, (playerPayout.get(hex.terrain) ?? 0) + (structure.kind === 'city' ? 2 : 1));
      payouts.set(structure.ownerId, playerPayout);
    }
  });

  const summaries = gameState.players.flatMap((player) => {
    const payout = payouts.get(player.id);
    if (!payout) return [];
    const resources = (Object.keys(resourceIcons) as ResourceTerrain[])
      .flatMap((terrain) => payout.get(terrain) ? [`${resourceIcons[terrain]}×${payout.get(terrain)}`] : []);
    return resources.length ? [`${player.name}: ${resources.join(' ')}`] : [];
  });
  return summaries.length ? summaries.join(' · ') : 'No player receives resources';
}

function vertexPosition(key: string): { x: number; y: number } | null {
  const [x, y] = key.split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: x / 100, y: y / 100 } : null;
}

function edgeGeometry(key: string): { x: number; y: number; length: number; angle: number } | null {
  const [aKey, bKey] = key.split('|');
  const a = vertexPosition(aKey);
  const b = vertexPosition(bKey);
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, length: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) };
}

function playerColor(playerId: string, gameState: GameState): number {
  const player = gameState.players.find((candidate) => candidate.id === playerId);
  return Number.parseInt((palette[player?.colorIndex ?? 0] ?? palette[0]).slice(1), 16);
}

async function ensurePlacementCanvas(): Promise<void> {
  if (placementApp) return;
  if (placementInitialization) return placementInitialization;
  placementInitialization = (async () => {
    const app = new Application();
    await app.init({
      resizeTo: placementViewport,
      antialias: true,
      background: 0x0b5362,
      resolution: Math.min(devicePixelRatio, 2),
      autoDensity: true,
      autoStart: false,
      eventFeatures: { move: true, globalMove: false, click: true, wheel: false },
    });
    placementViewport.prepend(app.canvas);
    const world = new Container();
    app.stage.addChild(world);
    placementApp = app;
    placementWorld = world;
    new ResizeObserver(() => {
      if (placementDialog.open && state) renderPlacementScene(state);
    }).observe(placementViewport);
  })();
  await placementInitialization;
}

function applyPlacementTarget(target: PlacementTarget): void {
  if (!pendingPlacementMode) return;
  send({ type: 'placement:apply', mode: pendingPlacementMode, target });
  send({ type: 'build:set', mode: null });
  pendingPlacementMode = null;
  if (placementDialog.open) placementDialog.close();
}

function applyRobberHex(q: number, r: number): void {
  if (!pendingRobberSelection) return;
  send({ type: 'robber:move', q, r });
  pendingRobberSelection = false;
  if (placementDialog.open) placementDialog.close();
}

function renderPlacementScene(gameState: GameState): void {
  const app = placementApp;
  const world = placementWorld;
  if (!app || !world) return;
  world.removeChildren().forEach((child) => child.destroy({ children: true }));

  const centers = gameState.island.hexes.map((hex) => axialToPlacementPixel(hex.q, hex.r));
  gameState.island.hexes.forEach((hex, index) => {
    const center = centers[index];
    const tile = new Graphics()
      .poly(placementHexPoints)
      .fill(terrainColors[hex.terrain])
      .stroke({ color: 0xe8d8ad, width: 3, alpha: .8 });
    tile.position.set(center.x, center.y);
    world.addChild(tile);
    if (hex.number !== null) {
      const number = new Text({ text: String(hex.number), style: { fontFamily: 'system-ui, sans-serif', fontSize: 22, fontWeight: 'bold', fill: 0x173238 } });
      number.anchor.set(.5);
      number.position.set(center.x, center.y);
      world.addChild(number);
    }
  });

  gameState.routes.forEach((route) => {
    const edge = edgeGeometry(route.edgeKey);
    if (!edge) return;
    const road = new Graphics().roundRect(-edge.length / 2 + 7, -5, edge.length - 14, 10, 4).fill(playerColor(route.ownerId, gameState)).stroke({ color: 0xffffff, width: 1.5, alpha: .7 });
    road.position.set(edge.x, edge.y);
    road.rotation = edge.angle;
    world.addChild(road);
  });
  gameState.structures.forEach((structure) => {
    const position = vertexPosition(structure.vertexKey);
    if (!position) return;
    const color = playerColor(structure.ownerId, gameState);
    const piece = structure.kind === 'city'
      ? new Graphics().roundRect(-12, -12, 24, 24, 5).fill(color).stroke({ color: 0xffffff, width: 2, alpha: .8 })
      : new Graphics().circle(0, 0, 10).fill(color).stroke({ color: 0xffffff, width: 2, alpha: .8 });
    piece.position.set(position.x, position.y);
    world.addChild(piece);
  });

  const targets = gameState.placementTargets ?? [];
  if (pendingRobberSelection) {
    gameState.island.hexes.forEach((hex, index) => {
      const center = centers[index];
      const isCurrent = hex.q === gameState.island.robber.q && hex.r === gameState.island.robber.r;
      const marker = new Graphics()
        .poly(placementHexPoints)
        .fill({ color: isCurrent ? 0x101a1d : 0xffd36a, alpha: isCurrent ? .48 : .16 })
        .stroke({ color: isCurrent ? 0x2d383a : 0xffe39a, width: isCurrent ? 3 : 6, alpha: isCurrent ? .8 : 1 });
      marker.position.set(center.x, center.y);
      if (!isCurrent) {
        marker.eventMode = 'static';
        marker.cursor = 'pointer';
        marker.hitArea = new Polygon(placementHexPoints);
        marker.on('pointertap', () => applyRobberHex(hex.q, hex.r));
      }
      world.addChild(marker);
      if (isCurrent) {
        const robber = new Text({ text: '♟', style: { fontFamily: 'system-ui, sans-serif', fontSize: 36, fontWeight: 'bold', fill: 0xf3eee1 } });
        robber.anchor.set(.5);
        robber.position.set(center.x, center.y + 3);
        world.addChild(robber);
      }
    });
  } else {
    const targetColor = pendingPlacementMode === 'remove' ? 0xff665c : 0xffe08a;
    targets.forEach((target) => {
      if (target.type === 'vertex') {
        const position = vertexPosition(target.key);
        if (!position) return;
        const marker = new Graphics().circle(0, 0, 16).fill({ color: targetColor, alpha: .42 }).stroke({ color: targetColor, width: 5, alpha: 1 });
        marker.position.set(position.x, position.y);
        marker.eventMode = 'static';
        marker.cursor = 'pointer';
        marker.hitArea = new Circle(0, 0, 25);
        marker.on('pointertap', () => applyPlacementTarget(target));
        world.addChild(marker);
      } else {
        const edge = edgeGeometry(target.key);
        if (!edge) return;
        const marker = new Graphics().roundRect(-edge.length / 2 + 4, -10, edge.length - 8, 20, 9).fill({ color: targetColor, alpha: .4 }).stroke({ color: targetColor, width: 4, alpha: 1 });
        marker.position.set(edge.x, edge.y);
        marker.rotation = edge.angle;
        marker.eventMode = 'static';
        marker.cursor = 'pointer';
        marker.hitArea = new Rectangle(-edge.length / 2, -18, edge.length, 36);
        marker.on('pointertap', () => applyPlacementTarget(target));
        world.addChild(marker);
      }
    });
  }

  const minX = Math.min(...centers.map((center) => center.x)) - PLACEMENT_HEX_SIZE;
  const maxX = Math.max(...centers.map((center) => center.x)) + PLACEMENT_HEX_SIZE;
  const minY = Math.min(...centers.map((center) => center.y)) - PLACEMENT_HEX_SIZE;
  const maxY = Math.max(...centers.map((center) => center.y)) + PLACEMENT_HEX_SIZE;
  const scale = Math.min((app.screen.width - 24) / (maxX - minX), (app.screen.height - 24) / (maxY - minY));
  world.scale.set(scale);
  world.position.set(app.screen.width / 2 - ((minX + maxX) / 2) * scale, app.screen.height / 2 - ((minY + maxY) / 2) * scale);
  placementLoading.hidden = true;
  placementHelp.textContent = pendingRobberSelection
    ? 'Tap any glowing hex. The robber must move away from its current hex.'
    : targets.length > 0 ? 'Tap a glowing location to place or remove the selected piece.' : 'No valid locations are available for this action.';
  app.render();
}

async function openPlacement(mode: Exclude<PlacementMode, null>): Promise<void> {
  pendingRobberSelection = false;
  pendingPlacementMode = mode;
  placementTitle.textContent = mode === 'remove' ? 'Remove a piece' : `Place ${mode === 'road' ? 'a road' : `a ${mode}`}`;
  placementLoading.hidden = false;
  placementHelp.textContent = 'Finding available locations…';
  placementDialog.showModal();
  send({ type: 'build:set', mode });
  await ensurePlacementCanvas();
  if (state?.placementMode === mode) renderPlacementScene(state);
}

async function openRobberSelection(): Promise<void> {
  pendingPlacementMode = null;
  pendingRobberSelection = true;
  placementTitle.textContent = 'Move the robber';
  placementLoading.hidden = false;
  placementHelp.textContent = 'Loading the island…';
  if (!placementDialog.open) placementDialog.showModal();
  await ensurePlacementCanvas();
  if (state?.robberPlacementPending) renderPlacementScene(state);
}

function cancelPlacement(): void {
  if (pendingRobberSelection) send({ type: 'robber:cancel' });
  else send({ type: 'build:set', mode: null });
  pendingRobberSelection = false;
  pendingPlacementMode = null;
  if (placementDialog.open) placementDialog.close();
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
      const awards = `${currentState.longestRoad?.holderId === player.id ? '🛣 ' : ''}${currentState.largestArmy?.holderId === player.id ? '♞ ' : ''}`;
      const name = document.createElement('strong'); name.textContent = `${awards}${player.name}`;
      const score = document.createElement('span'); score.textContent = `${scoreFor(player.id)} VP`;
      button.append(dot, name, score);
      button.addEventListener('click', () => send({ type: 'player:select', index }));
      playersList.append(button);
    });
  }

  const activePlayer = state?.players[state.activePlayerIndex];
  const activePlayerColor = palette[activePlayer?.colorIndex ?? 0] ?? palette[0];
  document.body.style.setProperty('--active-player-color', activePlayerColor);
  playKnightButton.disabled = !usable || !activePlayer || !!state?.robberPlacementPending;
  knightCardPlayer.textContent = activePlayer ? `${activePlayer.name} · ${activePlayer.knightsPlayed ?? 0} played` : 'Select an active player';

  knightsList.replaceChildren();
  (state?.players ?? []).forEach((player) => {
    const count = Math.max(0, player.knightsPlayed ?? 0);
    const row = document.createElement('div'); row.className = 'knight-row'; row.style.setProperty('--player-color', palette[player.colorIndex] ?? palette[0]);
    const identity = document.createElement('div'); identity.className = 'knight-row__identity';
    const dot = document.createElement('span'); dot.className = 'knight-row__dot';
    const name = document.createElement('strong'); name.textContent = player.name;
    identity.append(dot, name);
    const controls = document.createElement('div'); controls.className = 'knight-counter';
    const subtract = document.createElement('button'); subtract.type = 'button'; subtract.textContent = '−'; subtract.disabled = !usable || count === 0; subtract.setAttribute('aria-label', `Remove one played Knight from ${player.name}`);
    const value = document.createElement('output'); value.textContent = String(count); value.setAttribute('aria-label', `${player.name} has played ${count} Knights`);
    const add = document.createElement('button'); add.type = 'button'; add.textContent = '+'; add.disabled = !usable; add.setAttribute('aria-label', `Add one played Knight for ${player.name}`);
    subtract.addEventListener('click', () => send({ type: 'knight:adjust', playerId: player.id, delta: -1 }));
    add.addEventListener('click', () => send({ type: 'knight:adjust', playerId: player.id, delta: 1 }));
    controls.append(subtract, value, add);
    row.append(identity, controls);
    knightsList.append(row);
  });
  if (!state?.players.length) {
    const empty = document.createElement('p'); empty.className = 'controller-empty'; empty.textContent = 'Add players to track Knights.'; knightsList.append(empty);
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
  clearRollButton.disabled = !usable || (state?.lastRoll === null && !state?.robberPlacementPending);
  clearRollLabel.textContent = state?.robberPlacementPending ? 'Cancel' : 'Clear';
  clearRollButton.setAttribute('aria-label', state?.robberPlacementPending ? 'Cancel robber move' : 'Clear dice roll');
  editPlayersButton.disabled = !usable || !!state?.robberPlacementPending;
  newBoardButton.disabled = !usable || !!state?.robberPlacementPending;
  resetViewButton.disabled = !usable;
  makeAdjustmentsButton.disabled = !usable;
  buildStatus.textContent = state?.buildStatus ?? 'Waiting for the board…';
  const payoutSummary = state ? productionSummary(state) : null;
  rollStatus.textContent = payoutSummary ?? state?.rollStatus ?? 'Choose a roll';
  rollStatus.classList.toggle('roll-status--payout', payoutSummary !== null);
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
    knightsPlayed: state?.players.find((player) => player.id === row.dataset.playerId)?.knightsPlayed ?? 0,
  }));
  if (players.some((player) => !player.name)) return;
  send({ type: 'players:set', players });
  setupDialog.close();
});
setupDialog.addEventListener('cancel', (event) => { if (!state?.players.length) event.preventDefault(); });
editPlayersButton.addEventListener('click', openSetup);
addPlayerButton.addEventListener('click', () => addPlayerField());
cancelSetupButton.addEventListener('click', () => setupDialog.close());
buildButtons.forEach((button) => button.addEventListener('click', () => { void openPlacement(button.dataset.build as Exclude<PlacementMode, null>); }));
cancelBuildButton.addEventListener('click', cancelPlacement);
placementCloseButton.addEventListener('click', cancelPlacement);
placementDialog.addEventListener('cancel', (event) => { event.preventDefault(); cancelPlacement(); });
diceButtons.forEach((button) => button.addEventListener('click', () => send({ type: 'roll:set', total: Number(button.dataset.roll) })));
playKnightButton.addEventListener('click', () => send({ type: 'knight:play' }));
clearRollButton.addEventListener('click', () => send({ type: 'roll:clear' }));
resetViewButton.addEventListener('click', () => send({ type: 'view:reset' }));
newBoardButton.addEventListener('click', () => { if (window.confirm('Create a new island and clear all placed pieces?')) send({ type: 'island:new' }); });
makeAdjustmentsButton.addEventListener('click', () => adjustmentsDialog.showModal());
adjustmentsCloseButton.addEventListener('click', () => adjustmentsDialog.close());

const client = connectRealtime({
  role: 'controls',
  onConnectionChange(connected) { socketConnected = connected; updateConnection(); },
  onMessage(message) {
    if (message.type === 'presence') { boardConnected = message.boards > 0; updateConnection(); }
    if (message.type === 'state') {
      state = message.state;
      render();
      if (state.robberPlacementPending) {
        if (!pendingRobberSelection) void openRobberSelection();
        else if (placementDialog.open) renderPlacementScene(state);
      } else if (pendingRobberSelection) {
        pendingRobberSelection = false;
        if (placementDialog.open) placementDialog.close();
      } else if (placementDialog.open && pendingPlacementMode === state.placementMode) {
        renderPlacementScene(state);
      }
      if (!state.players.length && !promptedForPlayers) { promptedForPlayers = true; openSetup(); }
    }
  },
});

render();
