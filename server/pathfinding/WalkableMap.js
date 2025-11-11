"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findPath = findPath;
exports.getMapMetadata = getMapMetadata;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const BLOCKING_LAYERS = new Set([
    'Wall',
    'Objects',
    'ObjectsOnCollide',
    'GenericObjects',
    'GenericObjectsOnCollide',
    'Computer',
    'Whiteboard',
    'VendingMachine',
    'Chair',
]);
class WalkableMap {
    constructor(grid, width, height, tileWidth, tileHeight) {
        this.grid = grid;
        this.width = width;
        this.height = height;
        this.tileWidth = tileWidth;
        this.tileHeight = tileHeight;
    }
    getTileMetadata() {
        return { tileWidth: this.tileWidth, tileHeight: this.tileHeight };
    }
    static fromTiledJson(jsonPath) {
        const absolute = path_1.default.resolve(jsonPath);
        const file = fs_1.default.readFileSync(absolute, 'utf-8');
        const data = JSON.parse(file);
        const { width, height, tilewidth, tileheight } = data;
        const grid = Array.from({ length: height }, () => Array(width).fill(0));
        const blockingGids = WalkableMap.extractBlockingGids(data.tilesets);
        data.layers.forEach((layer) => {
            if (!layer || typeof layer !== 'object')
                return;
            if (layer.type === 'tilelayer' && Array.isArray(layer.data)) {
                layer.data.forEach((gid, index) => {
                    const rawGid = Number(gid) || 0;
                    if (!rawGid)
                        return;
                    const tileGid = rawGid & 0x1fffffff;
                    if (!blockingGids.has(tileGid))
                        return;
                    const x = index % width;
                    const y = Math.floor(index / width);
                    if (x >= 0 && y >= 0 && x < width && y < height) {
                        grid[y][x] = 1;
                    }
                });
            }
        });
        const EPS = 1e-4;
        const markTile = (tx, ty) => {
            if (tx < 0 || ty < 0 || tx >= width || ty >= height)
                return;
            grid[ty][tx] = 1;
        };
        const markRectangle = (left, top, objWidth, objHeight) => {
            const startX = Math.max(0, Math.floor(left / tilewidth));
            const startY = Math.max(0, Math.floor(top / tileheight));
            const endX = Math.min(width - 1, Math.floor((left + objWidth - EPS) / tilewidth));
            const endY = Math.min(height - 1, Math.floor((top + objHeight - EPS) / tileheight));
            for (let ty = startY; ty <= endY; ty += 1) {
                for (let tx = startX; tx <= endX; tx += 1) {
                    markTile(tx, ty);
                }
            }
        };
        const pointInPolygon = (point, polygon) => {
            let inside = false;
            for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
                const xi = polygon[i].x;
                const yi = polygon[i].y;
                const xj = polygon[j].x;
                const yj = polygon[j].y;
                const intersect = yi > point.y !== yj > point.y &&
                    point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + EPS) + xi;
                if (intersect)
                    inside = !inside;
            }
            return inside;
        };
        const rasterizePolygon = (polygon) => {
            if (!polygon.length)
                return;
            let minX = Infinity;
            let maxX = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;
            polygon.forEach((p) => {
                if (p.x < minX)
                    minX = p.x;
                if (p.x > maxX)
                    maxX = p.x;
                if (p.y < minY)
                    minY = p.y;
                if (p.y > maxY)
                    maxY = p.y;
            });
            if (!Number.isFinite(minX) || !Number.isFinite(minY))
                return;
            const startY = Math.max(0, Math.floor(minY / tileheight));
            const endY = Math.min(height - 1, Math.floor((maxY - EPS) / tileheight));
            const startX = Math.max(0, Math.floor(minX / tilewidth));
            const endX = Math.min(width - 1, Math.floor((maxX - EPS) / tilewidth));
            for (let ty = startY; ty <= endY; ty += 1) {
                const scanY = ty * tileheight + tileheight / 2;
                const intersections = [];
                for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
                    const p1 = polygon[i];
                    const p2 = polygon[j];
                    if ((p1.y <= scanY && p2.y > scanY) ||
                        (p2.y <= scanY && p1.y > scanY)) {
                        const slope = (p2.x - p1.x) / (p2.y - p1.y + EPS);
                        const x = p1.x + (scanY - p1.y) * slope;
                        intersections.push(x);
                    }
                }
                if (!intersections.length)
                    continue;
                intersections.sort((a, b) => a - b);
                for (let idx = 0; idx < intersections.length; idx += 2) {
                    const startX = intersections[idx];
                    const endX = intersections[idx + 1];
                    if (typeof startX !== 'number' || typeof endX !== 'number')
                        continue;
                    const tileStart = Math.max(0, Math.floor(startX / tilewidth));
                    const tileEnd = Math.min(width - 1, Math.floor((endX - EPS) / tilewidth));
                    for (let tx = tileStart; tx <= tileEnd; tx += 1) {
                        markTile(tx, ty);
                    }
                }
            }
            for (let ty = startY; ty <= endY; ty += 1) {
                for (let tx = startX; tx <= endX; tx += 1) {
                    if (grid[ty][tx] === 1)
                        continue;
                    const center = {
                        x: tx * tilewidth + tilewidth / 2,
                        y: ty * tileheight + tileheight / 2,
                    };
                    if (pointInPolygon(center, polygon)) {
                        markTile(tx, ty);
                    }
                }
            }
            polygon.forEach((point) => {
                const tx = Math.floor(point.x / tilewidth);
                const ty = Math.floor(point.y / tileheight);
                markTile(tx, ty);
            });
        };
        const markEllipse = (left, top, objWidth, objHeight) => {
            if (objWidth <= 0 || objHeight <= 0)
                return;
            const centerX = left + objWidth / 2;
            const centerY = top + objHeight / 2;
            const radiusX = objWidth / 2;
            const radiusY = objHeight / 2;
            const startX = Math.max(0, Math.floor((centerX - radiusX) / tilewidth));
            const endX = Math.min(width - 1, Math.floor((centerX + radiusX - EPS) / tilewidth));
            const startY = Math.max(0, Math.floor((centerY - radiusY) / tileheight));
            const endY = Math.min(height - 1, Math.floor((centerY + radiusY - EPS) / tileheight));
            for (let ty = startY; ty <= endY; ty += 1) {
                for (let tx = startX; tx <= endX; tx += 1) {
                    const center = {
                        x: tx * tilewidth + tilewidth / 2,
                        y: ty * tileheight + tileheight / 2,
                    };
                    const normX = (center.x - centerX) / radiusX;
                    const normY = (center.y - centerY) / radiusY;
                    if (normX * normX + normY * normY <= 1) {
                        markTile(tx, ty);
                    }
                }
            }
        };
        const rotatePoint = (px, py, originX, originY, radians) => {
            if (!radians) {
                return { x: originX + px, y: originY + py };
            }
            const cos = Math.cos(radians);
            const sin = Math.sin(radians);
            const dx = px;
            const dy = py;
            return {
                x: originX + dx * cos - dy * sin,
                y: originY + dx * sin + dy * cos,
            };
        };
        data.layers.forEach((layer) => {
            if (!layer || typeof layer !== 'object')
                return;
            if (!BLOCKING_LAYERS.has(layer.name))
                return;
            if (!Array.isArray(layer.objects))
                return;
            layer.objects.forEach((obj) => {
                if (!obj)
                    return;
                const widthPx = Number(obj.width) || tilewidth;
                const heightPx = Number(obj.height) || tileheight;
                const rawX = Number(obj.x) || 0;
                const rawY = Number(obj.y) || 0;
                const rotationDeg = Number(obj.rotation) || 0;
                const rotationRad = (rotationDeg * Math.PI) / 180;
                const isTile = Boolean(obj.gid);
                const top = isTile ? rawY - heightPx : rawY;
                const left = rawX;
                if (Array.isArray(obj.polygon) && obj.polygon.length >= 3) {
                    const originX = rawX;
                    const originY = rawY;
                    const polygon = obj.polygon.map((pt) => {
                        const px = Number(pt.x) || 0;
                        const py = Number(pt.y) || 0;
                        return rotatePoint(px, py, originX, originY, rotationRad);
                    });
                    rasterizePolygon(polygon);
                    return;
                }
                if (obj.ellipse) {
                    markEllipse(left, top, widthPx, heightPx);
                    return;
                }
                if (rotationDeg) {
                    const rectPoints = [
                        rotatePoint(0, 0, left, top, rotationRad),
                        rotatePoint(widthPx, 0, left, top, rotationRad),
                        rotatePoint(widthPx, heightPx, left, top, rotationRad),
                        rotatePoint(0, heightPx, left, top, rotationRad),
                    ];
                    rasterizePolygon(rectPoints);
                    return;
                }
                markRectangle(left, top, widthPx, heightPx);
            });
        });
        return new WalkableMap(grid, width, height, tilewidth, tileheight);
    }
    static extractBlockingGids(tilesets) {
        const blocked = new Set();
        if (!Array.isArray(tilesets))
            return blocked;
        tilesets.forEach((tileset) => {
            if (!tileset || typeof tileset !== 'object')
                return;
            const firstGid = Number(tileset.firstgid);
            if (!Number.isFinite(firstGid))
                return;
            if (!Array.isArray(tileset.tiles))
                return;
            tileset.tiles.forEach((tile) => {
                if (!tile || typeof tile !== 'object')
                    return;
                if (!Array.isArray(tile.properties))
                    return;
                const hasCollision = tile.properties.some((prop) => prop && prop.name === 'collides' && prop.value === true);
                if (hasCollision) {
                    blocked.add(firstGid + Number(tile.id || 0));
                }
            });
        });
        return blocked;
    }
    tileKey(tile) {
        return `${tile.x},${tile.y}`;
    }
    toTile(point) {
        return {
            x: Math.max(0, Math.min(this.width - 1, Math.floor(point.x / this.tileWidth))),
            y: Math.max(0, Math.min(this.height - 1, Math.floor(point.y / this.tileHeight))),
        };
    }
    toPixel(tile) {
        return {
            x: tile.x * this.tileWidth + this.tileWidth / 2,
            y: tile.y * this.tileHeight + this.tileHeight / 2,
        };
    }
    isWalkable(tile) {
        if (tile.x < 0 || tile.y < 0 || tile.x >= this.width || tile.y >= this.height)
            return false;
        return this.grid[tile.y][tile.x] === 0;
    }
    findPath(start, target) {
        const startTile = this.toTile(start);
        const targetTile = this.toTile(target);
        if (startTile.x === targetTile.x && startTile.y === targetTile.y) {
            return [this.toPixel(targetTile)];
        }
        const openSet = new Map();
        const gScore = new Map();
        const cameFrom = new Map();
        const tileByKey = new Map();
        const closedSet = new Set();
        const heuristic = (tile) => Math.abs(tile.x - targetTile.x) + Math.abs(tile.y - targetTile.y);
        const initialKey = this.tileKey(startTile);
        openSet.set(initialKey, {
            tile: startTile,
            f: heuristic(startTile),
        });
        gScore.set(initialKey, 0);
        cameFrom.set(initialKey, undefined);
        tileByKey.set(initialKey, startTile);
        const directions = [
            { x: 1, y: 0 },
            { x: -1, y: 0 },
            { x: 0, y: 1 },
            { x: 0, y: -1 },
        ];
        while (openSet.size > 0) {
            let currentKey = null;
            let currentNode = null;
            openSet.forEach((node, key) => {
                var _a;
                if (!currentNode || node.f < ((_a = currentNode === null || currentNode === void 0 ? void 0 : currentNode.f) !== null && _a !== void 0 ? _a : Infinity)) {
                    currentNode = node;
                    currentKey = key;
                }
            });
            if (!currentNode || currentKey === null)
                break;
            if (currentNode.tile.x === targetTile.x && currentNode.tile.y === targetTile.y) {
                const pathTiles = [];
                let key = currentKey;
                while (key) {
                    const tile = tileByKey.get(key);
                    if (tile)
                        pathTiles.push(tile);
                    key = cameFrom.get(key);
                }
                pathTiles.reverse();
                return pathTiles.map((tile) => this.toPixel(tile));
            }
            openSet.delete(currentKey);
            closedSet.add(currentKey);
            directions.forEach((dir) => {
                var _a;
                const neighbor = { x: currentNode.tile.x + dir.x, y: currentNode.tile.y + dir.y };
                const neighborKey = this.tileKey(neighbor);
                if (closedSet.has(neighborKey))
                    return;
                if (!this.isWalkable(neighbor))
                    return;
                const tentativeG = ((_a = gScore.get(currentKey)) !== null && _a !== void 0 ? _a : Infinity) + 1;
                const existingG = gScore.get(neighborKey);
                if (existingG !== undefined && tentativeG >= existingG)
                    return;
                cameFrom.set(neighborKey, currentKey);
                gScore.set(neighborKey, tentativeG);
                tileByKey.set(neighborKey, neighbor);
                const fScore = tentativeG + heuristic(neighbor);
                openSet.set(neighborKey, {
                    tile: neighbor,
                    f: fScore,
                });
            });
        }
        return null;
    }
}
const DEFAULT_MAP_PATH = path_1.default.join(__dirname, '..', '..', 'client', 'public', 'assets', 'map', 'map.json');
const DEFAULT_GRID_PATH = path_1.default.join(__dirname, '..', '..', 'client', 'public', 'assets', 'map', 'walkable-grid.json');
function computeGridHash(grid) {
    return crypto_1.default.createHash('sha256').update(JSON.stringify(grid)).digest('hex');
}
function loadPrecomputedGrid(filePath, expected) {
    var _a, _b, _c, _d, _e, _f;
    if (!fs_1.default.existsSync(filePath))
        return null;
    const raw = fs_1.default.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.grid) || data.grid.length === 0) {
        throw new Error('precomputed grid invalid: missing grid array');
    }
    const height = data.grid.length;
    const width = Array.isArray(data.grid[0]) ? data.grid[0].length : 0;
    if (!width || data.grid.some((row) => !Array.isArray(row) || row.length !== width)) {
        throw new Error('precomputed grid invalid: inconsistent row width');
    }
    if (expected) {
        if (width !== expected.width || height !== expected.height) {
            throw new Error(`precomputed grid size mismatch (expected ${expected.width}x${expected.height}, got ${width}x${height})`);
        }
        const tileWidthCandidate = Number((_b = (_a = data.map) === null || _a === void 0 ? void 0 : _a.tileWidth) !== null && _b !== void 0 ? _b : expected.tileWidth);
        const tileHeightCandidate = Number((_d = (_c = data.map) === null || _c === void 0 ? void 0 : _c.tileHeight) !== null && _d !== void 0 ? _d : expected.tileHeight);
        if (tileWidthCandidate !== expected.tileWidth || tileHeightCandidate !== expected.tileHeight) {
            throw new Error(`precomputed tile size mismatch (expected ${expected.tileWidth}x${expected.tileHeight}, got ${tileWidthCandidate}x${tileHeightCandidate})`);
        }
        if (expected.mapHash) {
            if (!data.mapHash) {
                throw new Error('precomputed grid missing mapHash; please re-run npm run export:walkable-grid');
            }
            if (data.mapHash !== expected.mapHash) {
                throw new Error(`precomputed grid mapHash mismatch (expected ${expected.mapHash}, got ${data.mapHash}); re-run export script`);
            }
        }
    }
    const tileWidth = Number((_e = data.map) === null || _e === void 0 ? void 0 : _e.tileWidth) || (expected === null || expected === void 0 ? void 0 : expected.tileWidth) || 32;
    const tileHeight = Number((_f = data.map) === null || _f === void 0 ? void 0 : _f.tileHeight) || (expected === null || expected === void 0 ? void 0 : expected.tileHeight) || 32;
    const grid = data.grid.map((row) => row.map((value) => (value ? 1 : 0)));
    const computedGridHash = computeGridHash(grid);
    if (data.gridHash && data.gridHash !== computedGridHash) {
        throw new Error('precomputed grid hash mismatch; please re-run npm run export:walkable-grid');
    }
    console.log(`[walkable-map] loaded precomputed grid ${width}x${height} (tile ${tileWidth}x${tileHeight}) version=${data.version || 'n/a'} generatedAt=${data.generatedAt || 'n/a'} mapHash=${data.mapHash || 'n/a'} gridHash=${data.gridHash || computedGridHash}`);
    return new WalkableMap(grid, width, height, tileWidth, tileHeight);
}
function buildDefaultMap() {
    let mapRaw = null;
    let mapData = null;
    let mapHash;
    try {
        mapRaw = fs_1.default.readFileSync(DEFAULT_MAP_PATH, 'utf-8');
        mapHash = crypto_1.default.createHash('sha256').update(mapRaw).digest('hex');
        mapData = JSON.parse(mapRaw);
    }
    catch (err) {
        console.warn('[walkable-map] failed to parse map.json for metadata validation', err);
        mapRaw = null;
        mapData = null;
        mapHash = undefined;
    }
    if (mapData) {
        const precomputed = loadPrecomputedGrid(DEFAULT_GRID_PATH, {
            width: mapData.width,
            height: mapData.height,
            tileWidth: mapData.tilewidth,
            tileHeight: mapData.tileheight,
            mapHash,
        });
        if (precomputed) {
            return precomputed;
        }
    }
    else {
        const precomputed = loadPrecomputedGrid(DEFAULT_GRID_PATH);
        if (precomputed) {
            console.warn('[walkable-map] precomputed grid loaded without map metadata validation');
            return precomputed;
        }
    }
    console.warn('[walkable-map] precomputed grid missing; rebuilding from Tiled json');
    return WalkableMap.fromTiledJson(DEFAULT_MAP_PATH);
}
const walkableMap = buildDefaultMap();
function findPath(start, target) {
    return walkableMap.findPath(start, target);
}
function getMapMetadata() {
    return walkableMap.getTileMetadata();
}
