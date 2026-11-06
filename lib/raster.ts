export type Pixel = number[];

export interface RasterInit {
    width: number;
    height: number;
    /** Interleaved channel count, 1 (grey) through 4 (RGBA) */
    channels: number;
    /** Row-major, channel-interleaved samples; allocated zeroed when omitted */
    data?: Uint8Array;
}

/**
 * An 8-bit raster tile with interleaved channels. Pixel (0, 0) is the top left.
 */
export class Raster {
    readonly width: number;
    readonly height: number;
    readonly channels: number;
    readonly data: Uint8Array;

    constructor(init: RasterInit) {
        const { width, height, channels } = init;

        if (!Number.isInteger(width) || width <= 0) throw new RangeError(`Invalid raster width: ${width}`);
        if (!Number.isInteger(height) || height <= 0) throw new RangeError(`Invalid raster height: ${height}`);
        if (!Number.isInteger(channels) || channels < 1 || channels > 4) {
            throw new RangeError(`Invalid raster channel count: ${channels}`);
        }

        const length = width * height * channels;
        const data = init.data ?? new Uint8Array(length);

        if (data.length !== length) {
            throw new RangeError(`Raster data holds ${data.length} samples but ${width}x${height}x${channels} needs ${length}`);
        }

        this.width = width;
        this.height = height;
        this.channels = channels;
        this.data = data;
    }

    static alloc(width: number, height: number, channels = 4): Raster {
        return new Raster({ width, height, channels });
    }

    get square(): boolean {
        return this.width === this.height;
    }

    /** Offset of the first sample of pixel (x, y) in {@link data} */
    index(x: number, y: number): number {
        if (!Number.isInteger(x) || x < 0 || x >= this.width || !Number.isInteger(y) || y < 0 || y >= this.height) {
            throw new RangeError(`Pixel (${x}, ${y}) is outside a ${this.width}x${this.height} raster`);
        }

        return (y * this.width + x) * this.channels;
    }

    get(x: number, y: number): Pixel {
        const i = this.index(x, y);
        return Array.from(this.data.subarray(i, i + this.channels));
    }

    set(x: number, y: number, pixel: ArrayLike<number>): void {
        if (pixel.length !== this.channels) {
            throw new RangeError(`Pixel has ${pixel.length} samples but the raster has ${this.channels} channels`);
        }

        this.data.set(pixel, this.index(x, y));
    }

    clone(): Raster {
        return new Raster({
            width: this.width,
            height: this.height,
            channels: this.channels,
            data: this.data.slice(),
        });
    }

    /** Expand grey, grey+alpha or RGB pixels to RGBA; RGBA rasters are copied */
    toRGBA(): Raster {
        const out = Raster.alloc(this.width, this.height, 4);
        const pixels = this.width * this.height;
        const src = this.data;
        const dst = out.data;

        for (let i = 0; i < pixels; i++) {
            const s = i * this.channels;
            const d = i * 4;

            switch (this.channels) {
                case 1:
                    dst[d] = dst[d + 1] = dst[d + 2] = src[s];
                    dst[d + 3] = 255;
                    break;
                case 2:
                    dst[d] = dst[d + 1] = dst[d + 2] = src[s];
                    dst[d + 3] = src[s + 1];
                    break;
                case 3:
                    dst[d] = src[s];
                    dst[d + 1] = src[s + 1];
                    dst[d + 2] = src[s + 2];
                    dst[d + 3] = 255;
                    break;
                default:
                    dst[d] = src[s];
                    dst[d + 1] = src[s + 1];
                    dst[d + 2] = src[s + 2];
                    dst[d + 3] = src[s + 3];
            }
        }

        return out;
    }

    /** Copy a window of pixels into a new raster */
    crop(x: number, y: number, width: number, height: number): Raster {
        if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
            throw new RangeError(`Invalid crop size ${width}x${height}`);
        }

        this.index(x, y);
        this.index(x + width - 1, y + height - 1);

        const out = Raster.alloc(width, height, this.channels);
        const rowBytes = width * this.channels;

        for (let row = 0; row < height; row++) {
            const start = this.index(x, y + row);
            out.data.set(this.data.subarray(start, start + rowBytes), row * rowBytes);
        }

        return out;
    }
}
