export type RGBA = [number, number, number, number];

const HEX_PATTERN = /^#?([0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Parse RRGGBB or RRGGBBAA with an optional leading `#`; a missing alpha is opaque */
export function parseHex(value: string): RGBA {
    const match = HEX_PATTERN.exec(value);
    if (!match) throw new Error(`Invalid colour "${value}": expected RRGGBB or RRGGBBAA`);

    const hex = match[1];

    return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
        hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255,
    ];
}

/** Lower-case hex without `#`, dropping the alpha when it is opaque */
export function toHex(color: RGBA): string {
    return color
        .slice(0, color[3] === 255 ? 3 : 4)
        .map(c => c.toString(16).padStart(2, '0'))
        .join('');
}

export function toCSS([r, g, b, a]: RGBA): string {
    return `rgba(${r}, ${g}, ${b}, ${Math.round(a / 255 * 100) / 100})`;
}
