import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Tile, Raster, Terrain, Slope } from '../index.js';
import { decodeImage, encodePNG, encodeWebP, imageTerrainSource } from '../node.js';

const DEM = new Tile(12, 2048, 1024);

test('node: decodeImage reads PNG and WebP into rasters', async () => {
    const raw = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    const png = await sharp(Buffer.from(raw), { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer();

    const raster = await decodeImage(png);
    assert.equal(raster.width, 2);
    assert.equal(raster.height, 2);
    assert.equal(raster.channels, 3);
    assert.deepEqual(Array.from(raster.data), Array.from(raw));

    const webp = await sharp(Buffer.from(raw), { raw: { width: 2, height: 2, channels: 3 } }).webp({ lossless: true }).toBuffer();
    const fromWebp = await decodeImage(webp.buffer.slice(webp.byteOffset, webp.byteOffset + webp.byteLength));
    assert.deepEqual(Array.from(fromWebp.data), Array.from(raw));

    await assert.rejects(decodeImage(Uint8Array.from([1, 2, 3])), /not a supported raster image/);
});

test('node: encodePNG and encodeWebP round trip through decodeImage', async () => {
    const raster = Raster.alloc(3, 2, 4);
    raster.set(0, 0, [255, 0, 0, 255]);
    raster.set(2, 1, [0, 0, 255, 128]);

    const png = await decodeImage(await encodePNG(raster));
    assert.equal(png.channels, 4);
    assert.deepEqual(png.get(0, 0), [255, 0, 0, 255]);
    assert.deepEqual(png.get(2, 1), [0, 0, 255, 128]);

    const palette = await decodeImage(await encodePNG(raster, { palette: true, compressionLevel: 9 }));
    assert.deepEqual(palette.get(0, 0), [255, 0, 0, 255]);

    const webp = await decodeImage(await encodeWebP(raster, { lossless: true, quality: 100 }));
    assert.deepEqual(webp.get(2, 1), [0, 0, 255, 128]);

    const grey = new Raster({ width: 1, height: 1, channels: 1, data: Uint8Array.from([77]) });
    const decodedGrey = await decodeImage(await encodePNG(grey));
    assert.ok(decodedGrey.get(0, 0).slice(0, 3).every(v => v === 77));
});

test('node: imageTerrainSource feeds Terrain.fetch and Slope.render', async () => {
    const size = 16;
    const elevation = new Float32Array(size * size);
    for (let py = 0; py < size; py++) {
        const cell = DEM.resolution(py, size);
        for (let px = 0; px < size; px++) elevation[py * size + px] = 1000 + px * cell * Math.tan(33 * Math.PI / 180);
    }

    const png = await encodePNG(new Terrain(DEM, size, elevation).encode('terrarium'));
    const requested: string[] = [];

    const source = imageTerrainSource({
        encoding: 'terrarium',
        minzoom: 4,
        maxzoom: 12,
        fetch: async (tile) => {
            requested.push(tile.key);
            return tile.equals(DEM) ? png : null;
        },
    });

    const child = new Tile(14, DEM.x * 4 + 1, DEM.y * 4 + 2);
    const terrain = await Terrain.fetch(child, source);
    assert.ok(terrain);
    assert.deepEqual(requested, [DEM.key]);

    const shaded = await decodeImage(await encodePNG(Slope.render(terrain), { palette: true }));
    assert.deepEqual(shaded.get(8, 8), [255, 152, 0, 200]);

    assert.equal(await Terrain.fetch(new Tile(12, 0, 0), source), null);
});
