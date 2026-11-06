import { PbfReader } from 'pbf';
import Point from '@mapbox/point-geometry';
import { VectorTile } from '@mapbox/vector-tile';
import { fromVectorTileJs } from '@maplibre/vt-pbf';
import type { VectorTileFeatureLike, VectorTileLayerLike, VectorTileLike } from '@maplibre/vt-pbf';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { Tile } from './tile.js';

export type VectorGeometryType = 'Point' | 'LineString' | 'Polygon';
export type VectorValue = string | number | boolean;
export type VectorProperties = Record<string, VectorValue>;
/** [x, y] in tile space, 0..extent from the top left */
export type VectorPosition = [number, number];

export interface VectorFeature {
    id?: number;
    type: VectorGeometryType;
    /**
     * Point: a single part holding every position; LineString: one part per
     * line; Polygon: one part per ring, closed (first position repeated last),
     * exterior rings clockwise and holes counter-clockwise in tile space
     */
    geometry: VectorPosition[][];
    properties: VectorProperties;
}

export interface VectorLayerOptions {
    extent?: number;
    version?: number;
}

export const DEFAULT_EXTENT = 4096;

const GEOMETRY_TYPES: Record<VectorGeometryType, 1 | 2 | 3> = { Point: 1, LineString: 2, Polygon: 3 };
const GEOMETRY_NAMES: Record<number, VectorGeometryType | undefined> = { 1: 'Point', 2: 'LineString', 3: 'Polygon' };

function closed(ring: VectorPosition[]): boolean {
    const first = ring[0];
    const last = ring[ring.length - 1];
    return first[0] === last[0] && first[1] === last[1];
}

/** A named feature set within a {@link Vector} tile */
export class VectorLayer implements VectorTileLayerLike {
    readonly name: string;
    readonly extent: number;
    readonly version: number;
    readonly features: VectorFeature[] = [];

    constructor(name: string, opts: VectorLayerOptions = {}) {
        const extent = opts.extent ?? DEFAULT_EXTENT;
        const version = opts.version ?? 2;

        if (!name.length) throw new Error('Vector layers need a name');
        if (!Number.isInteger(extent) || extent <= 0) throw new RangeError(`Invalid layer extent: ${extent}`);
        if (!Number.isInteger(version) || version < 1) throw new RangeError(`Invalid layer version: ${version}`);

        this.name = name;
        this.extent = extent;
        this.version = version;
    }

    get length(): number {
        return this.features.length;
    }

    /** Validate and append a feature; polygon rings are closed when they are not already */
    add(feature: VectorFeature): this {
        if (!(feature.type in GEOMETRY_TYPES)) throw new Error(`Unsupported geometry type: ${feature.type}`);
        if (feature.id !== undefined && (!Number.isInteger(feature.id) || feature.id < 0)) {
            throw new RangeError(`Feature ids must be non-negative integers: ${feature.id}`);
        }
        if (!feature.geometry.length) throw new Error('Features need at least one geometry part');

        const minimum = feature.type === 'Polygon' ? 3 : feature.type === 'LineString' ? 2 : 1;

        const geometry = feature.geometry.map((part) => {
            for (const position of part) {
                if (position.length !== 2 || !Number.isFinite(position[0]) || !Number.isFinite(position[1])) {
                    throw new Error(`Invalid position: ${JSON.stringify(position)}`);
                }
            }

            if (feature.type !== 'Polygon') {
                if (part.length < minimum) throw new Error(`${feature.type} parts need at least ${minimum} positions`);
                return part.map(([x, y]) => [x, y] as VectorPosition);
            }

            const ring = part.map(([x, y]) => [x, y] as VectorPosition);
            if (ring.length && !closed(ring)) ring.push([ring[0][0], ring[0][1]]);
            if (ring.length < minimum + 1) throw new Error('Polygon rings need at least 3 distinct positions');
            return ring;
        });

        if (feature.type === 'Point' && geometry.length !== 1) {
            throw new Error('Point features hold every position in a single part');
        }

        for (const value of Object.values(feature.properties)) {
            if (!['string', 'number', 'boolean'].includes(typeof value)) {
                throw new Error(`Unsupported property value: ${String(value)}`);
            }
        }

        this.features.push({
            ...(feature.id !== undefined ? { id: feature.id } : {}),
            type: feature.type,
            geometry,
            properties: { ...feature.properties },
        });

        return this;
    }

    /** vt-pbf feature view; coordinates are rounded to the integer tile grid on encode */
    feature(i: number): VectorTileFeatureLike {
        const feature = this.features[i];
        if (!feature) throw new RangeError(`Layer ${this.name} has no feature ${i}`);

        return {
            type: GEOMETRY_TYPES[feature.type],
            properties: feature.properties,
            id: feature.id,
            extent: this.extent,
            loadGeometry: () => feature.geometry.map(part => part.map(([x, y]) => new Point(Math.round(x), Math.round(y)))),
        };
    }

    /** Features as GeoJSON in geographic coordinates for the tile they belong to */
    toGeoJSON(tile: Tile): Feature[] {
        return this.features.map((feature) => {
            const unproject = ([x, y]: VectorPosition) => tile.unproject(x, y, this.extent);
            let geometry: Geometry;

            if (feature.type === 'Point') {
                const points = feature.geometry[0].map(unproject);
                geometry = points.length === 1
                    ? { type: 'Point', coordinates: points[0] }
                    : { type: 'MultiPoint', coordinates: points };
            } else if (feature.type === 'LineString') {
                const lines = feature.geometry.map(part => part.map(unproject));
                geometry = lines.length === 1
                    ? { type: 'LineString', coordinates: lines[0] }
                    : { type: 'MultiLineString', coordinates: lines };
            } else {
                geometry = { type: 'Polygon', coordinates: feature.geometry.map(part => part.map(unproject)) };
            }

            return {
                type: 'Feature',
                ...(feature.id !== undefined ? { id: feature.id } : {}),
                properties: { ...feature.properties },
                geometry,
            };
        });
    }
}

/**
 * A Mapbox Vector Tile: named layers of features in tile space, encodable to
 * and decodable from the MVT protobuf format.
 */
export class Vector implements VectorTileLike {
    readonly layers: Record<string, VectorLayer> = {};

    /** Get a layer, creating it on first use */
    layer(name: string, opts?: VectorLayerOptions): VectorLayer {
        let layer = this.layers[name];
        if (!layer) {
            layer = new VectorLayer(name, opts);
            this.layers[name] = layer;
        }

        return layer;
    }

    get(name: string): VectorLayer | undefined {
        return this.layers[name];
    }

    get empty(): boolean {
        return Object.values(this.layers).every(layer => !layer.length);
    }

    /** Uncompressed MVT protobuf bytes */
    encode(): Uint8Array {
        return fromVectorTileJs(this);
    }

    static decode(data: Uint8Array | ArrayBuffer): Vector {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        const decoded = new VectorTile(new PbfReader(bytes));
        const vector = new Vector();

        for (const raw of Object.values(decoded.layers)) {
            const layer = vector.layer(raw.name, { extent: raw.extent, version: raw.version });

            for (let i = 0; i < raw.length; i++) {
                const feature = raw.feature(i);
                const type = GEOMETRY_NAMES[feature.type];
                if (!type) continue;

                const parts = feature.loadGeometry().map(part => part.map(p => [p.x, p.y] as VectorPosition));

                layer.add({
                    ...(feature.id !== undefined ? { id: feature.id } : {}),
                    type,
                    geometry: type === 'Point' ? [parts.flat()] : parts,
                    properties: feature.properties,
                });
            }
        }

        return vector;
    }

    /** Every layer's features as one GeoJSON FeatureCollection in geographic coordinates */
    toGeoJSON(tile: Tile): FeatureCollection {
        return {
            type: 'FeatureCollection',
            features: Object.values(this.layers).flatMap(layer => layer.toGeoJSON(tile)),
        };
    }
}
