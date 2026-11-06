export type PlacementMode = 'town' | 'city' | 'road' | null;

export type PlayerState = {
  id: string;
  name: string;
  colorIndex: number;
};

export type StoredIslandState = {
  version: 2;
  id: string;
  hexes: Array<{
    q: number;
    r: number;
    terrain: 'forest' | 'pasture' | 'fields' | 'hills' | 'mountains' | 'desert';
    number: number | null;
  }>;
  robber: { q: number; r: number };
};

export type GameState = {
  version: 1;
  island: StoredIslandState;
  players: PlayerState[];
  activePlayerIndex: number;
  structures: Array<{ vertexKey: string; ownerId: string; kind: 'town' | 'city' }>;
  routes: Array<{ edgeKey: string; ownerId: string; kind: 'road' }>;
  placementMode: PlacementMode;
  lastRoll: number | null;
  robberPlacementPending: boolean;
  buildStatus: string;
  rollStatus: string;
};

export type GameCommand =
  | { type: 'players:set'; players: PlayerState[] }
  | { type: 'player:select'; index: number }
  | { type: 'build:set'; mode: PlacementMode }
  | { type: 'roll:set'; total: number }
  | { type: 'roll:clear' }
  | { type: 'island:new' }
  | { type: 'view:reset' };

export type ClientMessage =
  | { type: 'hello'; role: 'board' | 'controls' }
  | { type: 'state:update'; state: GameState }
  | { type: 'command'; command: GameCommand };

export type ServerMessage =
  | { type: 'state'; state: GameState }
  | { type: 'state:request' }
  | { type: 'command'; command: GameCommand }
  | { type: 'presence'; boards: number; controls: number };
