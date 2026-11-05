import { Application, Assets, Circle, Container, Graphics, Polygon, Rectangle, Sprite, Text } from 'pixi.js';
import type { FederatedPointerEvent, Texture } from 'pixi.js';
import './style.css';

type TerrainKey = 'forest' | 'pasture' | 'fields' | 'hills' | 'mountains' | 'desert';
type ResourcePortKind = 'wood' | 'wool' | 'grain' | 'brick' | 'ore';
type PortKind = 'general' | ResourcePortKind;
type StructureKind = 'town' | 'city';
type RouteKind = 'road';
type PlacementMode = StructureKind | RouteKind | null;
type HexCoordinate = { q: number; r: number };
type Terrain = { key: TerrainKey; name: string; color: number; accent: number };
type Hex = HexCoordinate & { terrain: Terrain; number: number | null };
type Island = { id: string; hexes: Hex[]; robber: HexCoordinate };
type StoredHex = HexCoordinate & { terrain: TerrainKey; number: number | null };
type StoredIsland = { version: 1 | 2; id: string; hexes: StoredHex[]; robber?: HexCoordinate };
type Player = { id: string; name: string; colorIndex: number };
type Structure = { vertexKey: string; ownerId: string; kind: StructureKind };
type Route = { edgeKey: string; ownerId: string; kind: RouteKind };
type StoredGame = {
  version: 1 | 2;
  islandId: string;
  players: Player[];
  activePlayerIndex: number;
  structures: Structure[];
  routes?: Route[];
};

type TileView = {
  tile: Container;
  hex: Hex;
  shadow: Graphics;
  detail: Graphics;
  texture: Graphics;
  numberToken: Container | null;
  rollHighlight: Graphics;
  placementHighlight: Graphics;
  robberShade: Graphics;
  robberFigure: Graphics;
  hovered: boolean;
  phase: number;
  baseY: number;
  lift: number;
  liftVelocity: number;
};
type WaterView = { tile: Container; waves: Graphics; foam: Graphics; phase: number };
type Vertex = { key: string; x: number; y: number; neighbors: Set<string>; landTouches: number; waterTouches: number };
type Edge = { key: string; a: string; b: string; x: number; y: number; length: number; angle: number; landTouches: number; waterTouches: number };
type VertexView = { vertex: Vertex; node: Container; marker: Graphics; piece: Container | null; phase: number };
type EdgeView = { edge: Edge; node: Container; marker: Graphics; piece: Container | null; phase: number };
type PortView = { node: Container; baseX: number; baseY: number; outX: number; outY: number; phase: number };
type WindView = { node: Graphics; baseY: number; speed: number; phase: number };
type OceanMark = { node: Graphics; xRatio: number; yRatio: number; phase: number; drift: number };
type Tween = { elapsed: number; duration: number; update: (progress: number) => void };

const HEX_SIZE = 76;
const BOARD_RADIUS = 2;
const WATER_RADIUS = 3;
const ISLAND_CACHE_KEY = 'catan-enhanced:island:v1';
const GAME_CACHE_KEY = 'catan-enhanced:game:v1';
const SIDEBAR_CACHE_KEY = 'catan-enhanced:sidebar-collapsed';

const playerPalette = [
  { solid: 0xf2c45f, dark: 0x9b622b, css: '#f2c45f' },
  { solid: 0xe96d5f, dark: 0x8d3432, css: '#e96d5f' },
  { solid: 0x75c9bc, dark: 0x2e756f, css: '#75c9bc' },
  { solid: 0x8da9e8, dark: 0x455b9b, css: '#8da9e8' },
] as const;

const terrain: Record<TerrainKey, Terrain> = {
  forest: { key: 'forest', name: 'Forest', color: 0x2f6748, accent: 0x173f32 },
  pasture: { key: 'pasture', name: 'Pasture', color: 0x8bbf73, accent: 0xdbe7a7 },
  fields: { key: 'fields', name: 'Fields', color: 0xe0b84e, accent: 0x8e6b27 },
  hills: { key: 'hills', name: 'Hills', color: 0xb96545, accent: 0x773c31 },
  mountains: { key: 'mountains', name: 'Mountains', color: 0x748087, accent: 0xd4d8d1 },
  desert: { key: 'desert', name: 'Desert', color: 0xd4b47a, accent: 0xa57c4f },
};

const terrainSurfaceUrls: Record<TerrainKey, string> = {
  forest: '/assets/terrain/forest.webp',
  pasture: '/assets/terrain/pasture.webp',
  fields: '/assets/terrain/fields.webp',
  hills: '/assets/terrain/hills.webp',
  mountains: '/assets/terrain/mountains.webp',
  desert: '/assets/terrain/desert.webp',
};

const hexPoints = Array.from({ length: 6 }, (_, index) => {
  const angle = ((index * 60 - 30) * Math.PI) / 180;
  return [Math.cos(angle) * HEX_SIZE, Math.sin(angle) * HEX_SIZE];
}).flat();

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

const viewport = requireElement<HTMLDivElement>('board-viewport');
const app = new Application();
await app.init({
  resizeTo: viewport,
  antialias: true,
  backgroundAlpha: 0,
  resolution: Math.min(devicePixelRatio, 2),
  autoDensity: true,
  eventFeatures: { move: true, globalMove: false, click: true, wheel: false },
});
viewport.prepend(app.canvas);

const terrainSurfaceEntries = await Promise.all(
  (Object.entries(terrainSurfaceUrls) as [TerrainKey, string][]).map(async ([key, url]) => [key, await Assets.load<Texture>(url)] as const),
);
const terrainSurfaceTextures = Object.fromEntries(terrainSurfaceEntries) as Record<TerrainKey, Texture>;

const oceanLayer = new Container();
oceanLayer.eventMode = 'none';
app.stage.addChild(oceanLayer);
let board = new Container();
app.stage.addChild(board);

let activeIsland: Island | null = null;
let selectedTile: Container | null = null;
let currentScale = 1;
let tileViews: TileView[] = [];
let waterViews: WaterView[] = [];
let portViews: PortView[] = [];
let windViews: WindView[] = [];
let vertices = new Map<string, Vertex>();
let edges = new Map<string, Edge>();
let vertexViews = new Map<string, VertexView>();
let edgeViews = new Map<string, EdgeView>();
let structures = new Map<string, Structure>();
let routes = new Map<string, Route>();
let players: Player[] = [];
let activePlayerIndex = 0;
let placementMode: PlacementMode = null;
let robberPlacementPending = false;
let controlsLocked = false;
let sceneTime = 0;
const oceanMarks: OceanMark[] = [];
const tweens: Tween[] = [];

function shuffled<T>(values: T[]): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function hexDistance({ q, r }: HexCoordinate): number {
  return Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
}

function coordinates(radius = BOARD_RADIUS): HexCoordinate[] {
  const cells: HexCoordinate[] = [];
  for (let q = -radius; q <= radius; q += 1) {
    const minR = Math.max(-radius, -q - radius);
    const maxR = Math.min(radius, -q + radius);
    for (let r = minR; r <= maxR; r += 1) cells.push({ q, r });
  }
  return cells;
}

function waterCoordinates(): HexCoordinate[] {
  return coordinates(WATER_RADIUS).filter((coordinate) => hexDistance(coordinate) === WATER_RADIUS);
}

function areAdjacent(a: HexCoordinate, b: HexCoordinate): boolean {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2 === 1;
}

function createIsland(): Hex[] {
  const terrainBag: TerrainKey[] = [
    'forest', 'forest', 'forest', 'forest', 'pasture', 'pasture', 'pasture', 'pasture',
    'fields', 'fields', 'fields', 'fields', 'hills', 'hills', 'hills',
    'mountains', 'mountains', 'mountains', 'desert',
  ];
  const coords = coordinates();
  const terrains = shuffled(terrainBag);
  const landCells = coords.filter((_, index) => terrains[index] !== 'desert');
  const tokens = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
  let numberedCells = shuffled(landCells);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    numberedCells = shuffled(landCells);
    const hotCells = numberedCells.slice(0, 4);
    if (!hotCells.some((cell, index) => hotCells.slice(index + 1).some((other) => areAdjacent(cell, other)))) break;
  }
  const numberByCoordinate = new Map<string, number>();
  const orderedTokens = [6, 8, 6, 8, ...shuffled(tokens.filter((number) => number !== 6 && number !== 8))];
  numberedCells.forEach((cell, index) => numberByCoordinate.set(`${cell.q},${cell.r}`, orderedTokens[index]));
  return coords.map((cell, index) => ({ ...cell, terrain: terrain[terrains[index]], number: terrains[index] === 'desert' ? null : numberByCoordinate.get(`${cell.q},${cell.r}`) ?? null }));
}

function createIslandState(): Island {
  const hexes = createIsland();
  const desert = hexes.find((hex) => hex.terrain.key === 'desert');
  if (!desert) throw new Error('Generated island is missing its desert tile.');
  return { id: Math.random().toString(36).slice(2, 8).toUpperCase(), hexes, robber: { q: desert.q, r: desert.r } };
}

function isTerrainKey(value: unknown): value is TerrainKey { return typeof value === 'string' && value in terrain; }

function loadIsland(): Island | null {
  try {
    const cached = localStorage.getItem(ISLAND_CACHE_KEY);
    if (!cached) return null;
    const stored = JSON.parse(cached) as Partial<StoredIsland>;
    if ((stored.version !== 1 && stored.version !== 2) || typeof stored.id !== 'string' || !Array.isArray(stored.hexes) || stored.hexes.length !== 19) return null;
    const validNumbers = new Set([2, 3, 4, 5, 6, 8, 9, 10, 11, 12]);
    const expectedCoordinates = new Set(coordinates().map(({ q, r }) => `${q},${r}`));
    const seenCoordinates = new Set<string>();
    const valid = stored.hexes.every((hex) => {
      if (!hex || !Number.isInteger(hex.q) || !Number.isInteger(hex.r) || !isTerrainKey(hex.terrain)) return false;
      if (hex.number !== null && !validNumbers.has(hex.number)) return false;
      if ((hex.terrain === 'desert') !== (hex.number === null)) return false;
      const key = `${hex.q},${hex.r}`;
      if (!expectedCoordinates.has(key) || seenCoordinates.has(key)) return false;
      seenCoordinates.add(key);
      return true;
    });
    if (!valid) return null;
    const hexes = stored.hexes.map((hex) => ({ ...hex, terrain: terrain[hex.terrain] }));
    const desert = hexes.find((hex) => hex.terrain.key === 'desert');
    if (!desert) return null;
    const storedRobber = stored.version === 2 && stored.robber;
    const robberKey = storedRobber ? `${storedRobber.q},${storedRobber.r}` : '';
    const robber = storedRobber && expectedCoordinates.has(robberKey) ? { q: storedRobber.q, r: storedRobber.r } : { q: desert.q, r: desert.r };
    return { id: stored.id, hexes, robber };
  } catch (error) { console.warn('The saved island could not be restored.', error); return null; }
}

function saveIsland(island: Island): void {
  const stored: StoredIsland = { version: 2, id: island.id, hexes: island.hexes.map((hex) => ({ q: hex.q, r: hex.r, terrain: hex.terrain.key, number: hex.number })), robber: island.robber };
  try { localStorage.setItem(ISLAND_CACHE_KEY, JSON.stringify(stored)); }
  catch (error) { console.warn('The island could not be saved.', error); }
}

function loadGame(islandId: string): void {
  players = [];
  structures.clear();
  routes.clear();
  activePlayerIndex = 0;
  try {
    const cached = localStorage.getItem(GAME_CACHE_KEY);
    if (!cached) return;
    const stored = JSON.parse(cached) as Partial<StoredGame>;
    if ((stored.version !== 1 && stored.version !== 2) || stored.islandId !== islandId || !Array.isArray(stored.players) || stored.players.length < 2 || stored.players.length > 4 || !Array.isArray(stored.structures)) return;
    const validPlayers = stored.players.every((player, index) => player && typeof player.id === 'string' && typeof player.name === 'string' && player.name.trim() && player.colorIndex === index);
    if (!validPlayers) return;
    players = stored.players.map((player) => ({ ...player, name: player.name.trim().slice(0, 24) }));
    const playerIds = new Set(players.map((player) => player.id));
    stored.structures.forEach((structure) => {
      if (structure && typeof structure.vertexKey === 'string' && playerIds.has(structure.ownerId) && (structure.kind === 'town' || structure.kind === 'city')) structures.set(structure.vertexKey, { ...structure });
    });
    if (stored.version === 2 && Array.isArray(stored.routes)) {
      stored.routes.forEach((route) => {
        if (route && typeof route.edgeKey === 'string' && playerIds.has(route.ownerId) && route.kind === 'road') routes.set(route.edgeKey, { ...route });
      });
    }
    activePlayerIndex = Number.isInteger(stored.activePlayerIndex) ? Math.max(0, Math.min(players.length - 1, stored.activePlayerIndex!)) : 0;
  } catch (error) { console.warn('The saved game could not be restored.', error); }
}

function saveGame(): void {
  if (!activeIsland || players.length < 2) return;
  const stored: StoredGame = { version: 2, islandId: activeIsland.id, players, activePlayerIndex, structures: [...structures.values()], routes: [...routes.values()] };
  try { localStorage.setItem(GAME_CACHE_KEY, JSON.stringify(stored)); }
  catch (error) { console.warn('The game could not be saved.', error); }
}

function axialToPixel(q: number, r: number): { x: number; y: number } {
  return { x: HEX_SIZE * Math.sqrt(3) * (q + r / 2), y: HEX_SIZE * 1.5 * r };
}

function drawTerrainDetails(kind: TerrainKey, accent: number): Graphics {
  const detail = new Graphics();
  if (kind === 'forest') {
    [[-31, -18, 17], [0, -28, 20], [31, -13, 16], [-20, 17, 20], [16, 14, 22], [42, 20, 13]].forEach(([x, y, radius]) => {
      detail.circle(x + 4, y + 5, radius).fill({ color: 0x102d25, alpha: .42 });
      detail.circle(x, y, radius).fill({ color: accent, alpha: .98 });
      detail.circle(x - radius * .27, y - radius * .3, radius * .48).fill({ color: 0x639069, alpha: .62 });
      detail.circle(x + radius * .27, y + radius * .18, radius * .42).fill({ color: 0x244f3a, alpha: .62 });
    });
  } else if (kind === 'mountains') {
    [[-28, 9, 27], [8, -17, 32], [36, 18, 22]].forEach(([x, y, radius]) => {
      detail.ellipse(x + 5, y + 6, radius, radius * .65).fill({ color: 0x26353a, alpha: .42 });
      detail.poly([x, y - radius, x + radius, y + 4, x + 8, y + radius * .76, x - radius, y + 6]).fill({ color: 0x536268 });
      detail.poly([x, y - radius, x - radius, y + 6, x + 8, y + radius * .76]).fill({ color: 0x89959a, alpha: .9 });
      detail.poly([x, y - radius, x - radius * .35, y - radius * .38, x + radius * .18, y - radius * .26]).fill({ color: accent, alpha: .94 });
    });
  } else if (kind === 'fields') {
    [-36, -18, 0, 18, 36].forEach((x, index) => {
      const bend = index % 2 ? 6 : -5;
      detail.moveTo(x + 3, 37).bezierCurveTo(x + bend + 3, 12, x - bend + 3, -12, x + 3, -38).stroke({ color: 0x6f4f1e, width: 5, alpha: .32 });
      detail.moveTo(x, 35).bezierCurveTo(x + bend, 11, x - bend, -12, x, -37).stroke({ color: 0xffe282, width: 3, alpha: .75 });
    });
  } else if (kind === 'pasture') {
    [[-33, -18, 18], [1, -25, 24], [35, -10, 17], [-24, 23, 21], [20, 21, 23]].forEach(([x, y, radius]) => {
      detail.ellipse(x + 3, y + 5, radius, radius * .62).fill({ color: 0x426d3c, alpha: .3 });
      detail.ellipse(x, y, radius, radius * .62).fill({ color: accent, alpha: .34 });
      detail.ellipse(x - 4, y - 3, radius * .62, radius * .3).fill({ color: 0xe4efb8, alpha: .35 });
    });
    detail.ellipse(6, 11, 15, 9).fill({ color: 0x48523f, alpha: .25 });
    detail.circle(2, 6, 9).circle(11, 6, 8).circle(7, 1, 8).fill({ color: 0xf4efd9 });
    detail.ellipse(17, 7, 6, 5).fill(0x35483a).circle(19, 5, 1.3).fill(0xf4efd9);
  } else if (kind === 'hills') {
    [[-31, 4, 31], [9, -10, 38], [40, 19, 25]].forEach(([x, y, radius]) => {
      detail.circle(x + 5, y + 6, radius).fill({ color: 0x5b2c27, alpha: .32 });
      detail.circle(x, y, radius).fill({ color: accent, alpha: .5 });
      detail.circle(x - radius * .25, y - radius * .26, radius * .66).fill({ color: 0xdc8a58, alpha: .34 });
    });
  } else {
    [[-48, -18, 48, -5], [-46, 13, 49, 27]].forEach(([startX, y, endX, endY]) => {
      detail.moveTo(startX + 3, y + 5).bezierCurveTo(-18, y - 15, 18, y + 14, endX + 3, endY + 5).stroke({ color: 0x72533b, width: 8, alpha: .22 });
      detail.moveTo(startX, y).bezierCurveTo(-18, y - 15, 18, y + 14, endX, endY).stroke({ color: accent, width: 5, alpha: .5 });
      detail.moveTo(startX - 1, y - 2).bezierCurveTo(-18, y - 17, 18, y + 12, endX - 1, endY - 2).stroke({ color: 0xf1d59d, width: 2, alpha: .62 });
    });
  }
  return detail;
}

function drawTerrainTexture(kind: TerrainKey): Graphics {
  const texture = new Graphics();
  for (let index = 0; index < 17; index += 1) {
    const x = Math.sin(index * 12.47 + kind.length) * 54;
    const y = Math.cos(index * 8.93 + kind.length * 2) * 48;
    const radius = 1.2 + (index % 2) * .55;
    texture.circle(x + 1.5, y + 2, radius).fill({ color: 0x10292b, alpha: .13 });
    texture.circle(x, y, radius).fill({ color: kind === 'desert' ? 0xf4dda6 : 0xffffff, alpha: kind === 'desert' ? .18 : .12 });
  }
  return texture;
}

function createTile(hex: Hex): TileView {
  const tile = new Container();
  const position = axialToPixel(hex.q, hex.r);
  tile.position.set(position.x, position.y);
  tile.eventMode = 'static';
  tile.cursor = 'pointer';
  tile.hitArea = new Polygon(hexPoints);
  const shadow = new Graphics().poly(hexPoints).fill({ color: 0x03191b, alpha: .3 }); shadow.position.set(0, 7);
  const shape = new Graphics().poly(hexPoints).fill(hex.terrain.color).stroke({ color: 0xf4dda5, width: 2.5, alpha: .72 });
  const surface = new Sprite({ texture: terrainSurfaceTextures[hex.terrain.key], anchor: .5 });
  surface.width = HEX_SIZE * 2.02;
  surface.height = HEX_SIZE * 2.02;
  surface.rotation = (Math.abs(hex.q * 3 + hex.r * 5) % 4) * Math.PI / 2;
  surface.alpha = .9;
  const surfaceMask = new Graphics().poly(hexPoints.map((value) => value * .975)).fill(0xffffff);
  surface.mask = surfaceMask;
  const surfaceTone = new Graphics().poly(hexPoints.map((value) => value * .975)).fill({ color: hex.terrain.color, alpha: .18 });
  const innerLight = new Graphics().poly(hexPoints.map((value) => value * .93)).stroke({ color: 0xffffff, width: 2, alpha: .15 });
  const texture = drawTerrainTexture(hex.terrain.key);
  const detail = drawTerrainDetails(hex.terrain.key, hex.terrain.accent);
  tile.addChild(shadow, shape, surface, surfaceMask, surfaceTone, innerLight, texture, detail);
  let numberToken: Container | null = null;
  if (hex.number !== null) {
    numberToken = new Container();
    const tokenShadow = new Graphics().circle(0, 4, 23).fill({ color: 0x20271f, alpha: .24 });
    const token = new Graphics().circle(0, 0, 22).fill({ color: 0xf7eac7 }).stroke({ color: 0x6e543d, width: 2, alpha: .52 });
    const isHot = hex.number === 6 || hex.number === 8;
    const label = new Text({ text: String(hex.number), style: { fontFamily: 'Georgia, serif', fontSize: 25, fontWeight: 'bold', fill: isHot ? 0xb53c2e : 0x2d342f } });
    label.anchor.set(.5);
    numberToken.addChild(tokenShadow, token, label);
    tile.addChild(numberToken);
  }
  const rollHighlight = new Graphics().poly(hexPoints).fill({ color: 0xf4cb63, alpha: .22 }).stroke({ color: 0xffdf7e, width: 7, alpha: .95, alignment: 1 }); rollHighlight.visible = false;
  const placementHighlight = new Graphics().poly(hexPoints).fill({ color: 0x9ad9d4, alpha: .08 }).stroke({ color: 0xb9eee7, width: 5, alpha: .8, alignment: 1 }); placementHighlight.visible = false;
  const robberShade = new Graphics().poly(hexPoints).fill({ color: 0x071012, alpha: .62 }).stroke({ color: 0x111718, width: 4, alpha: .85, alignment: 1 }); robberShade.visible = false;
  const robberFigure = new Graphics().circle(0, -10, 9).roundRect(-8, -2, 16, 31, 7).fill({ color: 0x171c1d }).stroke({ color: 0xb8afa0, width: 2, alpha: .6 }); robberFigure.visible = false;
  tile.addChild(rollHighlight, placementHighlight, robberShade, robberFigure);
  const view: TileView = {
    tile, hex, shadow, detail, texture, numberToken, rollHighlight, placementHighlight, robberShade, robberFigure,
    hovered: false, phase: Math.random() * Math.PI * 2, baseY: position.y, lift: 0, liftVelocity: 0,
  };
  tile.on('pointerenter', () => { view.hovered = true; });
  tile.on('pointerleave', () => { view.hovered = false; });
  tile.on('pointertap', (event: FederatedPointerEvent) => {
    if (moved) return;
    event.stopPropagation();
    if (robberPlacementPending) moveRobber(view);
    else selectTile(tile);
  });
  return view;
}

function createWaterTile(coordinate: HexCoordinate): WaterView {
  const tile = new Container();
  const position = axialToPixel(coordinate.q, coordinate.r);
  tile.position.set(position.x, position.y);
  tile.eventMode = 'none';
  const shadow = new Graphics().poly(hexPoints).fill({ color: 0x031d2b, alpha: .25 }); shadow.position.set(0, 6);
  const body = new Graphics().poly(hexPoints).fill(0x126d7e).stroke({ color: 0x9ddbd8, width: 2, alpha: .4 });
  const depth = new Graphics().poly(hexPoints.map((value) => value * .9)).fill({ color: 0x0a4c61, alpha: .32 });
  const waves = new Graphics();
  [-24, 0, 24].forEach((y, index) => waves.moveTo(-43 + index * 3, y).bezierCurveTo(-20, y - 8, 16, y + 8, 43 - index * 3, y).stroke({ color: 0xa8e2dc, width: index === 1 ? 2.2 : 1.4, alpha: .28 }));
  const foam = new Graphics().poly(hexPoints.map((value) => value * .96)).stroke({ color: 0xd6eee5, width: 2, alpha: .11 });
  tile.addChild(shadow, body, depth, waves, foam);
  return { tile, waves, foam, phase: Math.random() * Math.PI * 2 };
}

function pointKey(x: number, y: number): string { return `${Math.round(x * 100)},${Math.round(y * 100)}`; }
function edgeKey(a: string, b: string): string { return a < b ? `${a}|${b}` : `${b}|${a}`; }

function buildBoardGraph(hexes: Hex[]): { vertices: Map<string, Vertex>; edges: Map<string, Edge> } {
  const vertexMap = new Map<string, Vertex>();
  const edgeMap = new Map<string, Edge>();
  const cells = [
    ...hexes.map((hex) => ({ q: hex.q, r: hex.r, water: false })),
    ...waterCoordinates().map((coordinate) => ({ ...coordinate, water: true })),
  ];
  cells.forEach((cell) => {
    const center = axialToPixel(cell.q, cell.r);
    const corners = Array.from({ length: 6 }, (_, index) => {
      const x = center.x + hexPoints[index * 2];
      const y = center.y + hexPoints[index * 2 + 1];
      const key = pointKey(x, y);
      if (!vertexMap.has(key)) vertexMap.set(key, { key, x, y, neighbors: new Set(), landTouches: 0, waterTouches: 0 });
      const vertex = vertexMap.get(key)!;
      if (cell.water) vertex.waterTouches += 1; else vertex.landTouches += 1;
      return key;
    });
    corners.forEach((a, index) => {
      const b = corners[(index + 1) % corners.length];
      vertexMap.get(a)!.neighbors.add(b);
      vertexMap.get(b)!.neighbors.add(a);
      const key = edgeKey(a, b);
      if (!edgeMap.has(key)) {
        const va = vertexMap.get(a)!;
        const vb = vertexMap.get(b)!;
        edgeMap.set(key, { key, a, b, x: (va.x + vb.x) / 2, y: (va.y + vb.y) / 2, length: Math.hypot(vb.x - va.x, vb.y - va.y), angle: Math.atan2(vb.y - va.y, vb.x - va.x), landTouches: 0, waterTouches: 0 });
      }
      const edge = edgeMap.get(key)!;
      if (cell.water) edge.waterTouches += 1; else edge.landTouches += 1;
    });
  });
  return { vertices: vertexMap, edges: edgeMap };
}

function currentPlayer(): Player | null { return players[activePlayerIndex] ?? null; }

function createVertexView(vertex: Vertex): VertexView {
  const node = new Container();
  node.position.set(vertex.x, vertex.y);
  node.eventMode = 'none';
  node.hitArea = new Circle(0, 0, 21);
  const marker = new Graphics().circle(0, 0, 13).fill({ color: 0xffffff, alpha: .14 }).stroke({ color: 0xffffff, width: 3, alpha: .95 }).circle(0, 0, 3).fill({ color: 0xffffff, alpha: .92 }); marker.visible = false;
  node.addChild(marker);
  const view: VertexView = { vertex, node, marker, piece: null, phase: Math.random() * Math.PI * 2 };
  node.on('pointerenter', () => { if (marker.visible) marker.scale.set(1.16); });
  node.on('pointerleave', () => marker.scale.set(1));
  node.on('pointertap', (event: FederatedPointerEvent) => {
    if (moved || (placementMode !== 'town' && placementMode !== 'city') || !marker.visible) return;
    event.stopPropagation();
    placeStructure(vertex.key);
  });
  return view;
}

function createEdgeView(edge: Edge): EdgeView {
  const node = new Container();
  node.position.set(edge.x, edge.y);
  node.rotation = edge.angle;
  node.eventMode = 'none';
  node.hitArea = new Rectangle(-edge.length / 2, -14, edge.length, 28);
  const marker = new Graphics().roundRect(-edge.length / 2 + 6, -7, edge.length - 12, 14, 7).fill({ color: 0xffffff, alpha: .16 }).stroke({ color: 0xffffff, width: 2.5, alpha: .92 }); marker.visible = false;
  node.addChild(marker);
  const view: EdgeView = { edge, node, marker, piece: null, phase: Math.random() * Math.PI * 2 };
  node.on('pointerenter', () => { if (marker.visible) marker.scale.y = 1.28; });
  node.on('pointerleave', () => { marker.scale.y = 1; });
  node.on('pointertap', (event: FederatedPointerEvent) => {
    if (moved || placementMode !== 'road' || !marker.visible) return;
    event.stopPropagation();
    placeRoute(edge.key);
  });
  return view;
}

function createStructureArt(kind: StructureKind, player: Player): Container {
  const color = playerPalette[player.colorIndex];
  const art = new Container();
  art.addChild(new Graphics().ellipse(1, 5, kind === 'city' ? 21 : 16, 7).fill({ color: 0x07181a, alpha: .4 }));
  if (kind === 'town') {
    const walls = new Graphics().roundRect(-12, -13, 24, 20, 3).fill(color.solid).stroke({ color: 0xf8ebca, width: 1.5, alpha: .55 });
    const roof = new Graphics().poly([-16, -12, 0, -28, 16, -12]).fill(color.dark).stroke({ color: 0xf8ebca, width: 1.5, alpha: .5 });
    const details = new Graphics().roundRect(-3, -4, 6, 11, 2).fill({ color: color.dark, alpha: .85 }).rect(5, -7, 4, 4).fill({ color: 0xffefad, alpha: .88 });
    art.addChild(walls, roof, details);
  } else {
    const base = new Graphics().roundRect(-19, -13, 38, 21, 3).fill(color.solid).stroke({ color: 0xf8ebca, width: 1.5, alpha: .55 });
    const towers = new Graphics().roundRect(-17, -29, 13, 27, 2).roundRect(5, -36, 12, 34, 2).fill(color.solid).stroke({ color: 0xf8ebca, width: 1.3, alpha: .5 });
    const roofs = new Graphics().poly([-20, -28, -10.5, -39, -1, -28]).poly([2, -35, 11, -47, 20, -35]).fill(color.dark);
    const windows = new Graphics().rect(-13, -22, 4, 5).rect(9, -28, 4, 5).rect(-2, -7, 5, 6).fill({ color: 0xffefad, alpha: .9 });
    const flag = new Graphics().moveTo(11, -47).lineTo(11, -58).stroke({ color: 0xf8ebca, width: 1.5 }).poly([12, -57, 23, -53, 12, -49]).fill(color.solid);
    art.addChild(base, towers, roofs, windows, flag);
  }
  return art;
}

function createRouteArt(player: Player, length: number): Container {
  const color = playerPalette[player.colorIndex];
  const art = new Container();
  art.addChild(
    new Graphics().roundRect(-length / 2 + 5, 2, length - 10, 9, 4).fill({ color: 0x071719, alpha: .38 }),
    new Graphics().roundRect(-length / 2 + 5, -5, length - 10, 10, 4).fill(color.dark).stroke({ color: 0xfff0cc, width: 1.4, alpha: .44 }),
    new Graphics().roundRect(-length / 2 + 10, -2, length - 20, 4, 2).fill({ color: color.solid, alpha: .96 }),
  );
  return art;
}

function animate(duration: number, update: (progress: number) => void, delay = 0): void { tweens.push({ elapsed: -delay, duration, update }); }
function popIn(piece: Container): void {
  piece.scale.set(.08);
  animate(430, (progress) => {
    const back = 1 + 1.70158 * Math.pow(progress - 1, 3) + 1.70158 * Math.pow(progress - 1, 2);
    piece.scale.set(Math.max(.08, back));
  });
}

function renderStructure(key: string, animateIn = false): void {
  const view = vertexViews.get(key);
  const structure = structures.get(key);
  if (!view) return;
  if (view.piece) { view.node.removeChild(view.piece); view.piece.destroy({ children: true }); view.piece = null; }
  if (!structure) return;
  const owner = players.find((player) => player.id === structure.ownerId);
  if (!owner) return;
  view.piece = createStructureArt(structure.kind, owner);
  view.node.addChild(view.piece);
  if (animateIn) popIn(view.piece);
}

function renderRoute(key: string, animateIn = false): void {
  const view = edgeViews.get(key);
  const route = routes.get(key);
  if (!view) return;
  if (view.piece) { view.node.removeChild(view.piece); view.piece.destroy({ children: true }); view.piece = null; }
  if (!route) return;
  const owner = players.find((player) => player.id === route.ownerId);
  if (!owner) return;
  view.piece = createRouteArt(owner, view.edge.length);
  view.node.addChild(view.piece);
  if (animateIn) popIn(view.piece);
}

function renderAllPieces(): void {
  vertexViews.forEach((view) => { if (view.piece) { view.node.removeChild(view.piece); view.piece.destroy({ children: true }); view.piece = null; } });
  edgeViews.forEach((view) => { if (view.piece) { view.node.removeChild(view.piece); view.piece.destroy({ children: true }); view.piece = null; } });
  const playerIds = new Set(players.map((player) => player.id));
  structures.forEach((structure, key) => { if (!vertices.has(key) || !playerIds.has(structure.ownerId)) structures.delete(key); });
  routes.forEach((route, key) => { if (!edges.has(key) || !playerIds.has(route.ownerId)) routes.delete(key); });
  structures.forEach((_, key) => renderStructure(key));
  routes.forEach((_, key) => renderRoute(key));
}

function canPlaceStructure(key: string, mode: StructureKind): boolean {
  const player = currentPlayer();
  const vertex = vertices.get(key);
  if (!player || !vertex || vertex.landTouches === 0) return false;
  const existing = structures.get(key);
  if (mode === 'city') return existing?.ownerId === player.id && existing.kind === 'town';
  if (existing) return false;
  if (![...vertex.neighbors].every((neighbor) => !structures.has(neighbor))) return false;
  const playerStructureCount = [...structures.values()].filter((structure) => structure.ownerId === player.id).length;
  if (playerStructureCount < 2) return true;
  return [...edges.values()].some((edge) =>
    (edge.a === key || edge.b === key) && routes.get(edge.key)?.ownerId === player.id,
  );
}

function canPlaceRoute(key: string): boolean {
  const edge = edges.get(key);
  const player = currentPlayer();
  if (!player || !edge || routes.has(key) || edge.landTouches === 0) return false;
  return [edge.a, edge.b].some((vertexKey) => {
    const structure = structures.get(vertexKey);
    if (structure) return structure.ownerId === player.id;
    return [...edges.values()].some((neighbor) =>
      neighbor.key !== key
      && (neighbor.a === vertexKey || neighbor.b === vertexKey)
      && routes.get(neighbor.key)?.ownerId === player.id,
    );
  });
}

function refreshPlacementTargets(): void {
  const player = currentPlayer();
  vertexViews.forEach((view) => {
    const valid = !!player && (placementMode === 'town' || placementMode === 'city') && canPlaceStructure(view.vertex.key, placementMode);
    view.marker.visible = valid;
    view.node.eventMode = valid ? 'static' : 'none';
    view.node.cursor = valid ? 'pointer' : 'default';
    if (valid) view.marker.tint = playerPalette[player.colorIndex].solid;
  });
  edgeViews.forEach((view) => {
    const valid = !!player && placementMode === 'road' && canPlaceRoute(view.edge.key);
    view.marker.visible = valid;
    view.node.eventMode = valid ? 'static' : 'none';
    view.node.cursor = valid ? 'pointer' : 'default';
    if (valid) view.marker.tint = playerPalette[player.colorIndex].solid;
  });
}

function placeStructure(key: string): void {
  const player = currentPlayer();
  if (!player || (placementMode !== 'town' && placementMode !== 'city') || !canPlaceStructure(key, placementMode)) return;
  structures.set(key, { vertexKey: key, ownerId: player.id, kind: placementMode });
  renderStructure(key, true);
  saveGame();
  updateScoreboard();
  refreshPlacementTargets();
  setBuildStatus(placementMode === 'town' ? `${player.name} founded a town. Keep placing or choose another piece.` : `${player.name} upgraded a town into a city.`);
}

function placeRoute(key: string): void {
  const player = currentPlayer();
  if (!player || placementMode !== 'road' || !canPlaceRoute(key)) return;
  routes.set(key, { edgeKey: key, ownerId: player.id, kind: 'road' });
  renderRoute(key, true);
  saveGame();
  updateScoreboard();
  refreshPlacementTargets();
  setBuildStatus(`${player.name} placed a road. Keep placing or choose another piece.`);
}

function createPortIcon(kind: ResourcePortKind): Graphics {
  const icon = new Graphics();
  if (kind === 'wood') {
    icon.roundRect(-7, -3, 14, 7, 3).fill({ color: 0xb97842 }).stroke({ color: 0xffdda0, width: 1, alpha: .8 });
    icon.circle(-5, .5, 2.2).stroke({ color: 0x704225, width: 1, alpha: .8 });
    icon.moveTo(-2, -2).lineTo(6, 2).stroke({ color: 0x704225, width: 1, alpha: .65 });
  } else if (kind === 'wool') {
    icon.circle(-4, 0, 4).circle(1, -1, 4.5).circle(5, 1, 3.5).fill({ color: 0xfff1cf });
    icon.circle(7, -1, 2.3).fill({ color: 0xb8c8b9 });
    icon.moveTo(-2, 3).lineTo(-2, 6).moveTo(4, 3).lineTo(4, 6).stroke({ color: 0xfff1cf, width: 1.5, cap: 'round' });
  } else if (kind === 'grain') {
    icon.moveTo(0, 7).lineTo(0, -7).stroke({ color: 0xf4ca62, width: 1.5, cap: 'round' });
    [-4, 0, 4].forEach((y, index) => {
      icon.ellipse(-2.5, y, 2.5, 1.5).fill({ color: 0xffdf78 });
      if (index < 2) icon.ellipse(2.5, y + 2, 2.5, 1.5).fill({ color: 0xffdf78 });
    });
  } else if (kind === 'brick') {
    icon.roundRect(-8, -6, 7, 5, 1).roundRect(0, -6, 8, 5, 1).roundRect(-6, 0, 8, 5, 1).roundRect(3, 0, 6, 5, 1)
      .fill({ color: 0xd77554 }).stroke({ color: 0xffc39f, width: .8, alpha: .65 });
  } else {
    icon.poly([0, -7, 7, -2, 5, 6, -5, 6, -7, -2]).fill({ color: 0xaebfc4 }).stroke({ color: 0xe8f2ec, width: 1, alpha: .8 });
    icon.moveTo(0, -7).lineTo(-1, 2).lineTo(5, 6).moveTo(-1, 2).lineTo(-7, -2).stroke({ color: 0x6f858d, width: 1, alpha: .8 });
  }
  return icon;
}

function createPorts(portLayer: Container): void {
  const coastal = [...edges.values()].filter((edge) => edge.landTouches === 1 && edge.waterTouches === 1).sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
  const portKinds: PortKind[] = ['general', 'wood', 'general', 'wool', 'general', 'grain', 'brick', 'general', 'ore'];
  portViews = [];
  portKinds.forEach((kind, index) => {
    const edge = coastal[Math.floor(index * coastal.length / portKinds.length)];
    if (!edge) return;
    const magnitude = Math.hypot(edge.x, edge.y) || 1;
    const outX = edge.x / magnitude;
    const outY = edge.y / magnitude;
    const directionX = Math.cos(edge.angle);
    const directionY = Math.sin(edge.angle);
    const node = new Container();
    node.position.set(edge.x, edge.y);
    node.eventMode = 'none';
    const dock = new Graphics();
    [-11, 11].forEach((offset) => {
      const startX = directionX * offset;
      const startY = directionY * offset;
      dock.moveTo(startX, startY).lineTo(startX + outX * 27, startY + outY * 27).stroke({ color: 0x9c6f3c, width: 5, alpha: .95 });
      dock.moveTo(startX, startY).lineTo(startX + outX * 27, startY + outY * 27).stroke({ color: 0xe8ba6b, width: 1.4, alpha: .8 });
    });
    dock.moveTo(-directionX * 14 + outX * 27, -directionY * 14 + outY * 27).lineTo(directionX * 14 + outX * 27, directionY * 14 + outY * 27).stroke({ color: 0xd6a254, width: 6, alpha: .95 });
    const buoy = new Graphics().circle(outX * 37 - directionX * 14, outY * 37 - directionY * 14, 4).circle(outX * 37 + directionX * 14, outY * 37 + directionY * 14, 4).fill({ color: 0xf2c45f }).stroke({ color: 0xffefbc, width: 1, alpha: .8 });
    const badge = new Graphics().roundRect(outX * 48 - 24, outY * 48 - 10, 48, 20, 8).fill({ color: 0x082c35, alpha: .92 }).stroke({ color: 0x8bd0c7, width: 1.2, alpha: .55 });
    const content = kind === 'general'
      ? new Text({ text: '3:1', style: { fontFamily: 'DM Sans, Arial, sans-serif', fontSize: 11, fontWeight: 'bold', fill: 0xffe5a3 } })
      : createPortIcon(kind);
    if (content instanceof Text) content.anchor.set(.5);
    content.position.set(outX * 48, outY * 48);
    node.addChild(dock, buoy, badge, content);
    portLayer.addChild(node);
    portViews.push({ node, baseX: edge.x, baseY: edge.y, outX, outY, phase: index * .9 });
  });
}

function createWind(windLayer: Container): void {
  windViews = [];
  for (let index = 0; index < 12; index += 1) {
    const node = new Graphics();
    const length = 50 + (index % 4) * 22;
    node.moveTo(-length / 2, 0).bezierCurveTo(-length / 6, -8, length / 5, 9, length / 2, 0).stroke({ color: 0xd8eee4, width: index % 3 === 0 ? 2 : 1.2, alpha: .25, cap: 'round' });
    node.moveTo(length / 2 - 17, -5).bezierCurveTo(length / 2 - 7, -2, length / 2 - 7, 4, length / 2, 0).stroke({ color: 0xd8eee4, width: 1, alpha: .18 });
    node.blendMode = 'screen';
    node.x = -520 + (index * 91) % 1040;
    const baseY = -370 + (index * 137) % 740;
    node.y = baseY;
    windLayer.addChild(node);
    windViews.push({ node, baseY, speed: 9 + (index % 5) * 2.4, phase: index * .67 });
  }
}

function selectTile(tile: Container): void {
  selectedTile = tile;
}

function sameCoordinate(a: HexCoordinate, b: HexCoordinate): boolean { return a.q === b.q && a.r === b.r; }
function updateRobberVisuals(): void {
  if (!activeIsland) return;
  tileViews.forEach((view) => {
    const occupied = sameCoordinate(view.hex, activeIsland!.robber);
    view.robberShade.visible = occupied;
    view.robberFigure.visible = occupied;
  });
}

function setRollStatus(message: string, urgent = false): void {
  const status = requireElement('roll-status');
  status.textContent = message;
  status.classList.toggle('roll-status--urgent', urgent);
}
function setBuildStatus(message: string, urgent = false): void {
  const status = requireElement('build-status');
  status.textContent = message;
  status.classList.toggle('build-status--urgent', urgent);
}
function setControlsLocked(locked: boolean): void {
  controlsLocked = locked;
  diceButtons.forEach((button) => { button.disabled = locked; });
  clearRollButton.disabled = locked || !diceButtons.some((button) => button.getAttribute('aria-pressed') === 'true');
  newBoardButton.disabled = locked;
  updateActionUi();
}
function clearRollHighlights(): void {
  tileViews.forEach((view) => { view.rollHighlight.visible = false; });
  diceButtons.forEach((button) => button.setAttribute('aria-pressed', 'false'));
  clearRollButton.disabled = true;
}

function beginRobberPlacement(): void {
  if (!activeIsland) return;
  placementMode = null;
  robberPlacementPending = true;
  setControlsLocked(true);
  setRollStatus('7 rolled — move the robber', true);
  setBuildStatus('Choose a different land hex for the robber.', true);
  tileViews.forEach((view) => {
    const isCurrent = sameCoordinate(view.hex, activeIsland!.robber);
    view.placementHighlight.visible = !isCurrent;
    view.tile.cursor = isCurrent ? 'not-allowed' : 'crosshair';
  });
  refreshPlacementTargets();
}

function moveRobber(view: TileView): void {
  if (!activeIsland || !robberPlacementPending) return;
  if (sameCoordinate(view.hex, activeIsland.robber)) { setRollStatus('The robber must move to a different hex', true); return; }
  activeIsland.robber = { q: view.hex.q, r: view.hex.r };
  robberPlacementPending = false;
  tileViews.forEach((tileView) => { tileView.placementHighlight.visible = false; tileView.tile.cursor = 'pointer'; });
  updateRobberVisuals();
  saveIsland(activeIsland);
  setControlsLocked(false);
  setRollStatus(`Robber moved to ${view.hex.terrain.name}`);
  setBuildStatus('Choose any piece to keep building.');
  selectTile(view.tile);
}

function handleRoll(total: number, button: HTMLButtonElement): void {
  if (robberPlacementPending) return;
  clearRollHighlights();
  button.setAttribute('aria-pressed', 'true');
  clearRollButton.disabled = false;
  if (total === 7) { beginRobberPlacement(); return; }
  const matchingTiles = tileViews.filter((view) => view.hex.number === total);
  matchingTiles.forEach((view) => { view.rollHighlight.visible = true; view.liftVelocity = -52; });
  const tileLabel = matchingTiles.length === 1 ? 'hex produces' : 'hexes produce';
  setRollStatus(matchingTiles.length > 0 ? `${matchingTiles.length} ${tileLabel}` : 'No matching hexes');
}

function renderIsland(island: Island): void {
  const oldBoard = board;
  tweens.length = 0;
  activeIsland = island;
  robberPlacementPending = false;
  placementMode = null;
  board = new Container();
  const waterLayer = new Container();
  const landLayer = new Container();
  const windLayer = new Container();
  const portLayer = new Container();
  const edgeLayer = new Container();
  const vertexLayer = new Container();
  waterLayer.sortableChildren = true;
  landLayer.sortableChildren = true;
  waterLayer.eventMode = 'none'; windLayer.eventMode = 'none'; portLayer.eventMode = 'none';
  board.addChild(waterLayer, landLayer, windLayer, portLayer, edgeLayer, vertexLayer);
  waterViews = waterCoordinates().map(createWaterTile);
  waterViews.forEach((view) => { view.tile.zIndex = view.tile.y; waterLayer.addChild(view.tile); });
  tileViews = island.hexes.map(createTile);
  tileViews.forEach((view) => {
    view.tile.zIndex = view.baseY;
    view.tile.alpha = 0;
    view.tile.scale.set(.94);
    landLayer.addChild(view.tile);
    animate(420, (progress) => {
      const eased = 1 - Math.pow(1 - progress, 3);
      const overshoot = 1 + 2.2 * Math.pow(progress - 1, 3) + 1.2 * Math.pow(progress - 1, 2);
      view.tile.alpha = eased;
      view.tile.scale.set(.94 + overshoot * .06);
    }, hexDistance(view.hex) * 75 + Math.random() * 35);
  });
  const graph = buildBoardGraph(island.hexes);
  vertices = graph.vertices;
  edges = graph.edges;
  createWind(windLayer);
  createPorts(portLayer);
  edgeViews = new Map();
  edges.forEach((edge) => {
    const view = createEdgeView(edge);
    edgeViews.set(edge.key, view);
    edgeLayer.addChild(view.node);
  });
  vertexViews = new Map();
  vertices.forEach((vertex) => {
    const view = createVertexView(vertex);
    vertexViews.set(vertex.key, view);
    vertexLayer.addChild(view.node);
  });
  app.stage.addChild(board);
  app.stage.removeChild(oldBoard);
  oldBoard.destroy({ children: true });
  renderAllPieces();
  updateRobberVisuals();
  setControlsLocked(false);
  clearRollHighlights();
  setRollStatus('Choose a roll');
  requireElement('board-seed').textContent = island.id;
  selectedTile = null;
  resetView();
  updateActionUi();
}

function replaceIsland(): void {
  const confirmed = window.confirm('Create a new island? Player names stay, but all pieces on this island will be cleared.');
  if (!confirmed) return;
  const island = createIslandState();
  structures.clear(); routes.clear(); activePlayerIndex = 0;
  saveIsland(island);
  renderIsland(island);
  saveGame();
  setBuildStatus(`${currentPlayer()?.name ?? 'Select a player'} is the active builder.`);
}

function resetView(): void {
  const width = app.screen.width;
  const height = app.screen.height;
  const boardHeight = HEX_SIZE * 11;
  currentScale = Math.min(1.8, Math.max(.3, (height - 12) / boardHeight));
  board.scale.set(currentScale);
  board.position.set(width / 2, height / 2);
}

function scoreFor(playerId: string): number {
  let score = 0;
  structures.forEach((structure) => { if (structure.ownerId === playerId) score += structure.kind === 'city' ? 2 : 1; });
  return score;
}

function updateScoreboard(): void {
  const list = requireElement('scoreboard-players');
  list.replaceChildren();
  players.forEach((player, index) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `score-card${index === activePlayerIndex ? ' score-card--active' : ''}`;
    card.style.setProperty('--player-color', playerPalette[player.colorIndex].css);
    card.setAttribute('aria-pressed', String(index === activePlayerIndex));
    const dot = document.createElement('span'); dot.className = 'score-card__dot';
    const name = document.createElement('span'); name.className = 'score-card__name'; name.textContent = player.name;
    const score = document.createElement('strong'); score.className = 'score-card__score'; score.textContent = String(scoreFor(player.id));
    const playerRoutes = [...routes.values()].filter((route) => route.ownerId === player.id);
    score.title = `${score.textContent} points · ${playerRoutes.length} roads`;
    card.append(dot, name, score);
    card.addEventListener('click', () => selectActivePlayer(index));
    list.append(card);
  });
  if (players.length === 0) {
    const empty = document.createElement('div'); empty.className = 'score-card'; empty.textContent = 'Name players to begin'; list.append(empty);
  }
}

function selectActivePlayer(index: number): void {
  if (!players[index]) return;
  activePlayerIndex = index;
  saveGame();
  updateActionUi();
  setBuildStatus(`${players[index].name} is now the active builder.`);
}

const buildButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-build]'));
const cancelBuildButton = requireElement<HTMLButtonElement>('cancel-build');
function updateActionUi(): void {
  const player = currentPlayer();
  const disabled = controlsLocked || !player;
  buildButtons.forEach((button) => { button.disabled = disabled; button.setAttribute('aria-pressed', String(button.dataset.build === placementMode)); });
  cancelBuildButton.hidden = placementMode === null;
  cancelBuildButton.disabled = disabled;
  requireElement('active-player-name').textContent = player?.name ?? 'Set up players';
  requireElement<HTMLElement>('active-player-dot').style.background = player ? playerPalette[player.colorIndex].css : '#668488';
  updateScoreboard();
  refreshPlacementTargets();
}

function setPlacementMode(mode: PlacementMode): void {
  if (!currentPlayer() || controlsLocked) return;
  placementMode = placementMode === mode ? null : mode;
  updateActionUi();
  if (!placementMode) { setBuildStatus('Choose any piece to keep building.'); return; }
  const structureMode = placementMode === 'town' || placementMode === 'city';
  const available = structureMode
    ? [...vertices.keys()].filter((key) => canPlaceStructure(key, placementMode as StructureKind)).length
    : [...edges.keys()].filter((key) => canPlaceRoute(key)).length;
  const messages: Record<Exclude<PlacementMode, null>, string> = {
    town: 'The first two towns may start freely; later towns must connect to your roads.',
    city: 'Choose one of this player’s glowing towns to upgrade.',
    road: 'Roads must connect to your town, city, or road network.',
  };
  setBuildStatus(available > 0 ? messages[placementMode] : `No available ${placementMode} locations.`, available === 0);
}

function createOceanMarks(): void {
  for (let index = 0; index < 24; index += 1) {
    const width = 28 + (index % 5) * 13;
    const node = new Graphics().ellipse(0, 0, width, 5 + (index % 3) * 2).stroke({ color: index % 3 === 0 ? 0xbce7df : 0x79bfc1, width: 1.4, alpha: .24 });
    node.blendMode = index % 4 === 0 ? 'screen' : 'normal';
    oceanLayer.addChild(node);
    oceanMarks.push({ node, xRatio: ((index * 37) % 100) / 100, yRatio: ((index * 61 + 13) % 100) / 100, phase: index * .73, drift: 5 + (index % 6) * 1.7 });
  }
}
function layoutOceanMarks(): void { oceanMarks.forEach((mark) => mark.node.position.set(mark.xRatio * app.screen.width, mark.yRatio * app.screen.height)); }

const setupDialog = requireElement<HTMLDialogElement>('setup-dialog');
const setupForm = requireElement<HTMLFormElement>('setup-form');
const playerFields = requireElement<HTMLDivElement>('player-fields');
const addPlayerButton = requireElement<HTMLButtonElement>('add-player');
const cancelSetupButton = requireElement<HTMLButtonElement>('cancel-setup');
function makePlayerId(): string { return Math.random().toString(36).slice(2, 9); }

function addPlayerField(name = '', id = ''): void {
  if (playerFields.children.length >= 4) return;
  const index = playerFields.children.length;
  const row = document.createElement('div'); row.className = 'player-field'; row.dataset.playerId = id; row.style.setProperty('--player-color', playerPalette[index].css);
  const number = document.createElement('span'); number.className = 'player-field__number'; number.textContent = String(index + 1);
  const input = document.createElement('input'); input.type = 'text'; input.name = 'player-name'; input.value = name; input.placeholder = `Player ${index + 1}`; input.maxLength = 24; input.required = true; input.autocomplete = 'off'; input.setAttribute('aria-label', `Player ${index + 1} name`);
  const remove = document.createElement('button'); remove.className = 'remove-player'; remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove player ${index + 1}`);
  remove.addEventListener('click', () => { if (playerFields.children.length <= 2) return; row.remove(); normalizePlayerFields(); });
  row.append(number, input, remove); playerFields.append(row); normalizePlayerFields();
}

function normalizePlayerFields(): void {
  Array.from(playerFields.children).forEach((child, index) => {
    const row = child as HTMLDivElement; row.style.setProperty('--player-color', playerPalette[index].css); row.querySelector('.player-field__number')!.textContent = String(index + 1);
    const input = row.querySelector<HTMLInputElement>('input')!; input.placeholder = `Player ${index + 1}`; input.setAttribute('aria-label', `Player ${index + 1} name`);
    row.querySelector<HTMLButtonElement>('.remove-player')!.hidden = playerFields.children.length <= 2;
  });
  addPlayerButton.hidden = playerFields.children.length >= 4;
}

function openSetup(): void {
  playerFields.replaceChildren();
  if (players.length) players.forEach((player) => addPlayerField(player.name, player.id));
  else { addPlayerField(); addPlayerField(); }
  cancelSetupButton.hidden = players.length === 0;
  setupDialog.showModal();
  window.setTimeout(() => playerFields.querySelector<HTMLInputElement>('input')?.focus(), 50);
}

setupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const rows = Array.from(playerFields.querySelectorAll<HTMLDivElement>('.player-field'));
  const nextPlayers = rows.map((row, index) => ({ id: row.dataset.playerId || makePlayerId(), name: row.querySelector<HTMLInputElement>('input')!.value.trim(), colorIndex: index }));
  if (nextPlayers.some((player) => !player.name)) return;
  players = nextPlayers;
  activePlayerIndex = Math.min(activePlayerIndex, players.length - 1);
  const activeIds = new Set(players.map((player) => player.id));
  structures.forEach((structure, key) => { if (!activeIds.has(structure.ownerId)) structures.delete(key); });
  routes.forEach((route, key) => { if (!activeIds.has(route.ownerId)) routes.delete(key); });
  renderAllPieces();
  setupDialog.close();
  saveGame();
  updateActionUi();
  setBuildStatus(`${currentPlayer()!.name} is the active builder. Choose any piece.`);
});
setupDialog.addEventListener('cancel', (event) => { if (!players.length) event.preventDefault(); });
addPlayerButton.addEventListener('click', () => addPlayerField());
cancelSetupButton.addEventListener('click', () => setupDialog.close());
requireElement('edit-players').addEventListener('click', openSetup);
buildButtons.forEach((button) => button.addEventListener('click', () => setPlacementMode(button.dataset.build as Exclude<PlacementMode, null>)));
cancelBuildButton.addEventListener('click', () => setPlacementMode(null));

const diceButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-roll]'));
const clearRollButton = requireElement<HTMLButtonElement>('clear-roll');
const newBoardButton = requireElement<HTMLButtonElement>('new-board');
diceButtons.forEach((button) => {
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', () => { const total = Number(button.dataset.roll); if (Number.isInteger(total)) handleRoll(total, button); });
});
clearRollButton.addEventListener('click', () => {
  if (robberPlacementPending) return;
  clearRollHighlights();
  setRollStatus('Choose a roll');
});

const gameShell = requireElement('game-shell');
const sidebarToggle = requireElement<HTMLButtonElement>('sidebar-toggle');
function setSidebarCollapsed(collapsed: boolean): void {
  gameShell.classList.toggle('sidebar-collapsed', collapsed);
  sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  try { localStorage.setItem(SIDEBAR_CACHE_KEY, String(collapsed)); } catch { /* optional preference */ }
}
sidebarToggle.addEventListener('click', () => setSidebarCollapsed(!gameShell.classList.contains('sidebar-collapsed')));
try { setSidebarCollapsed(localStorage.getItem(SIDEBAR_CACHE_KEY) === 'true'); } catch { setSidebarCollapsed(false); }

let dragging = false;
let moved = false;
let dragX = 0;
let dragY = 0;
app.canvas.addEventListener('pointerdown', (event) => { dragging = true; moved = false; dragX = event.clientX; dragY = event.clientY; app.canvas.setPointerCapture(event.pointerId); });
app.canvas.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  const dx = event.clientX - dragX; const dy = event.clientY - dragY;
  if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
  board.position.x += dx; board.position.y += dy; dragX = event.clientX; dragY = event.clientY;
});
app.canvas.addEventListener('pointerup', () => { dragging = false; });
app.canvas.addEventListener('pointercancel', () => { dragging = false; });
app.canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const rect = app.canvas.getBoundingClientRect();
  const pointerX = event.clientX - rect.left; const pointerY = event.clientY - rect.top;
  const nextScale = Math.min(1.8, Math.max(.3, currentScale * Math.exp(-event.deltaY * .001)));
  const worldX = (pointerX - board.position.x) / currentScale; const worldY = (pointerY - board.position.y) / currentScale;
  board.position.set(pointerX - worldX * nextScale, pointerY - worldY * nextScale); currentScale = nextScale; board.scale.set(currentScale);
}, { passive: false });

newBoardButton.addEventListener('click', replaceIsland);
requireElement('reset-view').addEventListener('click', resetView);
new ResizeObserver(() => { layoutOceanMarks(); if (!dragging) resetView(); }).observe(viewport);

app.ticker.add((ticker) => {
  const deltaSeconds = ticker.deltaMS / 1000;
  sceneTime += deltaSeconds;
  oceanMarks.forEach((mark) => {
    mark.node.x = mark.xRatio * app.screen.width + Math.sin(sceneTime * .28 + mark.phase) * mark.drift;
    mark.node.y = mark.yRatio * app.screen.height + Math.cos(sceneTime * .45 + mark.phase) * 4;
    mark.node.alpha = .45 + Math.sin(sceneTime * .8 + mark.phase) * .22;
  });
  waterViews.forEach((view) => {
    view.waves.x = Math.sin(sceneTime * .75 + view.phase) * 4;
    view.waves.y = Math.cos(sceneTime * .58 + view.phase) * 2;
    view.foam.alpha = .55 + Math.sin(sceneTime * 1.1 + view.phase) * .32;
    view.tile.scale.set(1 + Math.sin(sceneTime * .34 + view.phase) * .003);
  });
  tileViews.forEach((view) => {
    const physicsDelta = Math.min(deltaSeconds, .05);
    const targetLift = view.tile === selectedTile ? -3 : view.hovered ? -1 : 0;
    view.liftVelocity += (targetLift - view.lift) * 95 * physicsDelta;
    view.liftVelocity *= Math.exp(-16 * physicsDelta);
    view.lift += view.liftVelocity * physicsDelta;
    view.tile.y = view.baseY + view.lift;
    view.shadow.y = 7 - view.lift;
    const shadowSpread = 1 + Math.max(0, -view.lift) * .004;
    view.shadow.scale.set(shadowSpread, 1 + Math.max(0, -view.lift) * .002);
    view.shadow.alpha = .34 + Math.min(.12, Math.max(0, -view.lift) * .012);

    const sway = Math.sin(sceneTime * .72 + view.phase);
    view.detail.position.set(0, 0);
    view.detail.rotation = 0;
    view.detail.alpha = 1;
    if (view.hex.terrain.key === 'forest') view.detail.alpha = .96 + sway * .04;
    else if (view.hex.terrain.key === 'fields') view.detail.x = sway * .28;
    else if (view.hex.terrain.key === 'pasture') view.detail.y = sway * .18;
    else if (view.hex.terrain.key === 'hills') view.detail.alpha = .96 + sway * .04;
    else if (view.hex.terrain.key === 'mountains') view.detail.alpha = .93 + sway * .07;
    else { view.detail.x = sway * .2; view.detail.alpha = .92 + sway * .06; }
    view.texture.alpha = .64 + Math.sin(sceneTime * .28 + view.phase) * .06;
    if (view.numberToken) view.numberToken.y = Math.sin(sceneTime * .9 + view.phase) * .65;
    if (view.rollHighlight.visible) { const pulse = 1 + Math.sin(sceneTime * 4.8 + view.phase) * .018; view.rollHighlight.scale.set(pulse); view.rollHighlight.alpha = .82 + Math.sin(sceneTime * 5.2 + view.phase) * .16; }
    if (view.robberFigure.visible) view.robberFigure.y = Math.sin(sceneTime * 1.8 + view.phase) * 2;
  });
  windViews.forEach((view) => {
    view.node.x += view.speed * deltaSeconds;
    if (view.node.x > 540) view.node.x = -540;
    view.node.y = view.baseY + Math.sin(sceneTime * .55 + view.phase) * 18;
    view.node.alpha = .38 + Math.sin(sceneTime * .8 + view.phase) * .2;
  });
  portViews.forEach((view) => {
    const bob = Math.sin(sceneTime * 1.05 + view.phase) * 1.6;
    view.node.position.set(view.baseX + view.outX * bob, view.baseY + view.outY * bob);
    view.node.rotation = Math.sin(sceneTime * .45 + view.phase) * .006;
  });
  vertexViews.forEach((view) => {
    if (view.marker.visible) view.marker.alpha = .72 + Math.sin(sceneTime * 3.2 + view.phase) * .22;
    if (view.piece) view.piece.y = Math.sin(sceneTime * 1.35 + view.phase) * .75;
  });
  edgeViews.forEach((view) => {
    if (view.marker.visible) view.marker.alpha = .68 + Math.sin(sceneTime * 3 + view.phase) * .24;
    if (view.piece) view.piece.y = Math.sin(sceneTime * 1.2 + view.phase) * .45;
  });
  for (let index = tweens.length - 1; index >= 0; index -= 1) {
    const tween = tweens[index]; tween.elapsed += ticker.deltaMS;
    const progress = Math.min(1, tween.elapsed / tween.duration); tween.update(progress);
    if (progress >= 1) tweens.splice(index, 1);
  }
});

createOceanMarks();
layoutOceanMarks();
const cachedIsland = loadIsland();
const initialIsland = cachedIsland ?? createIslandState();
if (!cachedIsland) saveIsland(initialIsland);
loadGame(initialIsland.id);
renderIsland(initialIsland);
if (!players.length) openSetup();
