import sharp from 'sharp';
import { Raster } from './lib/raster.js';
import type { Tile } from './lib/tile.js';
import type { TerrainEncoding, TerrainSource } from './lib/terrain.js';

export type ImageInput = Uint8Array | ArrayBuffer;

function toBuffer(input: ImageInput): Buffer {
    return input instanceof ArrayBuffer ? Buffer.from(input) : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

/** Decode any image format sharp understands (PNG, WebP, JPEG, ...) into a raster */
export async function decodeImage(input: ImageInput): Promise<Raster> {
    let image;

    try {
        image = await sharp(toBuffer(input)).raw().toBuffer({ resolveWithObject: true });
    } catch (err) {
        throw new Error('Input is not a supported raster image', { cause: err });
    }

    return new Raster({
        width: image.info.width,
        height: image.info.height,
        channels: image.info.channels,
        data: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
    });
}

export interface PNGOptions {
    /** Quantise to an indexed palette, far smaller for class-coloured output such as slope shading */
    palette?: boolean;
    compressionLevel?: number;
}

export async function encodePNG(raster: Raster, opts: PNGOptions = {}): Promise<Buffer> {
    return await sharp(toBuffer(raster.data), {
        raw: { width: raster.width, height: raster.height, channels: raster.channels as 1 | 2 | 3 | 4 },
    }).png({
        palette: opts.palette ?? false,
        ...(opts.compressionLevel !== undefined ? { compressionLevel: opts.compressionLevel } : {}),
    }).toBuffer();
}

export interface WebPOptions {
    quality?: number;
    lossless?: boolean;
}

export async function encodeWebP(raster: Raster, opts: WebPOptions = {}): Promise<Buffer> {
    return await sharp(toBuffer(raster.data), {
        raw: { width: raster.width, height: raster.height, channels: raster.channels as 1 | 2 | 3 | 4 },
    }).webp({
        ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
        ...(opts.lossless !== undefined ? { lossless: opts.lossless } : {}),
    }).toBuffer();
}

export interface ImageTerrainSourceOptions {
    encoding: TerrainEncoding;
    minzoom: number;
    maxzoom: number;
    /** Encoded raster-dem tile bytes, or null where the source has no tile */
    fetch(tile: Tile): Promise<ImageInput | null>;
}

/** A {@link TerrainSource} over encoded image tiles, decoding each with sharp */
export function imageTerrainSource(opts: ImageTerrainSourceOptions): TerrainSource {
    return {
        encoding: opts.encoding,
        minzoom: opts.minzoom,
        maxzoom: opts.maxzoom,
        tile: async (tile) => {
            const raw = await opts.fetch(tile);
            return raw ? await decodeImage(raw) : null;
        },
    };
}
