import { Raster } from './raster.js';
import { parseHex, toHex } from './color.js';
import type { RGBA } from './color.js';
import type { Terrain } from './terrain.js';

/**
 * Shading algorithm. `standard` is the ESRI/GDAL formula (MapLibre calls it
 * `basic`); `combined` and `igor` leave flat ground fully lit and darken by
 * slope, `combined` by the angle to the light and `igor` only on slopes facing
 * away from it; `multidirectional` blends lights from 225, 270, 315 and 360
 * degrees weighted by aspect, so no slope is lost in shadow.
 */
export type HillshadeMethod = 'standard' | 'combined' | 'igor' | 'multidirectional';

export const HILLSHADE_METHODS: readonly HillshadeMethod[] = ['standard', 'combined', 'igor', 'multidirectional'];

export interface HillshadeOptions {
    /** Compass direction the light comes from in degrees; ignored by `multidirectional` */
    azimuth: number;
    /** Height of the light above the horizon in degrees, 0 sunset to 90 noon */
    altitude: number;
    /** Vertical exaggeration applied to the terrain before shading */
    exaggeration: number;
    method: HillshadeMethod;
    /** Colour of shaded pixels; its alpha scales with how dark the pixel is */
    shadow: RGBA;
    /** Colour of lit pixels; its alpha scales with how bright the pixel is */
    highlight: RGBA;
}

/** Raw hillshade parameters, as a query string or `args` map carries them */
export type HillshadeInput = Partial<Record<keyof HillshadeOptions, string | string[] | undefined>>;

export interface HillshadeColorOptions {
    shadow?: RGBA;
    highlight?: RGBA;
    /** Illumination that renders fully transparent; defaults to flat ground under the given light */
    neutral?: number;
}

const DEG = Math.PI / 180;
const MULTIDIRECTIONAL_AZIMUTHS = [225, 270, 315, 360];

function number(input: HillshadeInput, key: keyof HillshadeOptions, fallback: number, min: number, max: number, exclusiveMin = false): number {
    const raw = input[key];
    if (raw === undefined) return fallback;
    if (Array.isArray(raw)) throw new Error(`Invalid hillshade ${key}: expected a single value`);

    const value = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(value) || value > max || value < min || (exclusiveMin && value === min)) {
        throw new Error(`Invalid hillshade ${key} "${raw}": expected ${exclusiveMin ? `${min} <` : `${min} <=`} ${key} <= ${max}`);
    }

    return value;
}

function color(input: HillshadeInput, key: 'shadow' | 'highlight', fallback: RGBA): RGBA {
    const raw = input[key];
    if (raw === undefined) return fallback;
    if (Array.isArray(raw)) throw new Error(`Invalid hillshade ${key}: expected a single value`);

    try {
        return parseHex(raw);
    } catch (err) {
        throw new Error(`Invalid hillshade ${key}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
}

/**
 * Hillshade relief: parse and serialise lighting options, compute per-pixel
 * illumination for a {@link Terrain} and render it as a grey or transparent
 * RGBA raster. Use a padded terrain to avoid seams at tile edges.
 */
export class Hillshade {
    static readonly DEFAULTS: Readonly<HillshadeOptions> = {
        azimuth: 315,
        altitude: 45,
        exaggeration: 1,
        method: 'standard',
        shadow: [0, 0, 0, 255],
        highlight: [255, 255, 255, 255],
    };

    /** Fill and validate options from raw string parameters; unknown keys are ignored */
    static parse(input: HillshadeInput = {}): HillshadeOptions {
        const defaults = Hillshade.DEFAULTS;

        const rawMethod = input.method;
        let method = defaults.method;

        if (rawMethod !== undefined) {
            if (Array.isArray(rawMethod) || !HILLSHADE_METHODS.includes(rawMethod as HillshadeMethod)) {
                throw new Error(`Invalid hillshade method "${rawMethod}": expected one of ${HILLSHADE_METHODS.join(', ')}`);
            }

            method = rawMethod as HillshadeMethod;
        }

        return {
            azimuth: number(input, 'azimuth', defaults.azimuth, 0, 360),
            altitude: number(input, 'altitude', defaults.altitude, 0, 90),
            exaggeration: number(input, 'exaggeration', defaults.exaggeration, 0, 100, true),
            method,
            shadow: color(input, 'shadow', defaults.shadow),
            highlight: color(input, 'highlight', defaults.highlight),
        };
    }

    /** Normalised string parameters for every option, the inverse of {@link parse} */
    static serialize(opts: HillshadeOptions): Record<keyof HillshadeOptions, string> {
        return {
            azimuth: String(opts.azimuth),
            altitude: String(opts.altitude),
            exaggeration: String(opts.exaggeration),
            method: opts.method,
            shadow: toHex(opts.shadow),
            highlight: toHex(opts.highlight),
        };
    }

    /** Illumination of flat ground under these options, the value {@link colorize} leaves transparent */
    static neutral(opts: Pick<HillshadeOptions, 'altitude' | 'method'>): number {
        return opts.method === 'igor' || opts.method === 'combined' ? 1 : Math.sin(opts.altitude * DEG);
    }

    /** Illumination from 0 (black) to 1 (fully lit) for every pixel of the tile */
    static shade(terrain: Terrain, input: Partial<HillshadeOptions> = {}): Float32Array {
        const opts = { ...Hillshade.DEFAULTS, ...input };
        const { dzdx, dzdy } = terrain.gradient();
        const shade = new Float32Array(dzdx.length);

        const zenith = (90 - opts.altitude) * DEG;
        const cosZenith = Math.cos(zenith);
        const sinZenith = Math.sin(zenith);
        const light = Hillshade.lightAngle(opts.azimuth);

        for (let i = 0; i < shade.length; i++) {
            const dx = dzdx[i] * opts.exaggeration;
            const dy = dzdy[i] * opts.exaggeration;
            const slope = Math.atan(Math.sqrt(dx * dx + dy * dy));

            if (slope === 0) {
                shade[i] = Hillshade.neutral(opts);
                continue;
            }

            const aspect = Math.atan2(dy, -dx);
            let value: number;

            switch (opts.method) {
                case 'combined': {
                    const standard = Hillshade.standard(slope, aspect, light, cosZenith, sinZenith);
                    value = 1 - Math.acos(Math.min(Math.max(standard, -1), 1)) * slope / (Math.PI / 2) ** 2;
                    break;
                }
                case 'igor': {
                    const away = Hillshade.angleBetween(aspect, light + Math.PI);
                    value = 1 - (slope / (Math.PI / 2)) * (1 - away / Math.PI);
                    break;
                }
                case 'multidirectional': {
                    let sum = 0;
                    let weights = 0;

                    for (const azimuth of MULTIDIRECTIONAL_AZIMUTHS) {
                        const direction = Hillshade.lightAngle(azimuth);
                        const weight = Math.cos(aspect - direction) ** 2;
                        sum += weight * Hillshade.standard(slope, aspect, direction, cosZenith, sinZenith);
                        weights += weight;
                    }

                    value = sum / weights;
                    break;
                }
                default:
                    value = Hillshade.standard(slope, aspect, light, cosZenith, sinZenith);
            }

            shade[i] = Math.min(Math.max(value, 0), 1);
        }

        return shade;
    }

    /** Illumination as an opaque single channel raster */
    static grey(shade: Float32Array, size: number): Raster {
        const raster = Raster.alloc(size, size, 1);

        if (shade.length !== size * size) {
            throw new RangeError(`Shade grid holds ${shade.length} values but a ${size}px tile needs ${size * size}`);
        }

        for (let i = 0; i < shade.length; i++) raster.data[i] = Math.round(shade[i] * 255);

        return raster;
    }

    /**
     * Illumination as a transparent RGBA overlay: pixels darker than `neutral`
     * take the shadow colour and brighter pixels the highlight colour, each
     * with alpha proportional to the distance from neutral
     */
    static colorize(shade: Float32Array, size: number, input: HillshadeColorOptions = {}): Raster {
        const raster = Raster.alloc(size, size, 4);

        if (shade.length !== size * size) {
            throw new RangeError(`Shade grid holds ${shade.length} values but a ${size}px tile needs ${size * size}`);
        }

        const shadow = input.shadow ?? Hillshade.DEFAULTS.shadow;
        const highlight = input.highlight ?? Hillshade.DEFAULTS.highlight;
        const neutral = input.neutral ?? Hillshade.neutral(Hillshade.DEFAULTS);

        if (!(neutral >= 0 && neutral <= 1)) throw new RangeError(`Invalid neutral illumination: ${neutral}`);

        const { data } = raster;

        for (let i = 0; i < shade.length; i++) {
            const value = shade[i];
            let color: RGBA;
            let strength: number;

            if (value < neutral) {
                color = shadow;
                strength = (neutral - value) / neutral;
            } else if (value > neutral) {
                color = highlight;
                strength = (value - neutral) / (1 - neutral);
            } else {
                continue;
            }

            data[i * 4] = color[0];
            data[i * 4 + 1] = color[1];
            data[i * 4 + 2] = color[2];
            data[i * 4 + 3] = Math.round(color[3] * Math.min(strength, 1));
        }

        return raster;
    }

    /** Render a terrain tile as a transparent RGBA hillshade overlay */
    static render(terrain: Terrain, input: Partial<HillshadeOptions> = {}): Raster {
        const opts = { ...Hillshade.DEFAULTS, ...input };

        return Hillshade.colorize(Hillshade.shade(terrain, opts), terrain.size, {
            shadow: opts.shadow,
            highlight: opts.highlight,
            neutral: Hillshade.neutral(opts),
        });
    }

    /** Compass azimuth to the mathematical angle the gradient aspect is measured in */
    private static lightAngle(azimuth: number): number {
        return ((360 - azimuth + 90) % 360) * DEG;
    }

    private static standard(slope: number, aspect: number, light: number, cosZenith: number, sinZenith: number): number {
        return cosZenith * Math.cos(slope) + sinZenith * Math.sin(slope) * Math.cos(light - aspect);
    }

    /** Smallest angle between two directions, in [0, π] */
    private static angleBetween(a: number, b: number): number {
        const diff = Math.abs(a - b) % (2 * Math.PI);
        return diff > Math.PI ? 2 * Math.PI - diff : diff;
    }
}
