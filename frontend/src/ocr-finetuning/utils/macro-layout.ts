export type MacroRegionDef = {
    id: string;
    label: string;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    order: number;
};

export const MACRO_REGION_DEFS: MacroRegionDef[] = [
    { id: "header", label: "Header", x0: 0, y0: 0, x1: 1, y1: 0.15, order: 0 },
    { id: "address", label: "Address", x0: 0, y0: 0.12, x1: 0.55, y1: 0.38, order: 1 },
    { id: "meta", label: "Meta", x0: 0.55, y0: 0.12, x1: 1, y1: 0.38, order: 2 },
    { id: "body", label: "Body", x0: 0, y0: 0.32, x1: 1, y1: 0.88, order: 3 },
    { id: "footer", label: "Footer", x0: 0, y0: 0.85, x1: 1, y1: 1, order: 4 },
];

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

export function buildMacroRegions(width: number, height: number) {
    return MACRO_REGION_DEFS.map((def) => {
        const x = Math.round(clamp(def.x0, 0, 1) * width);
        const y = Math.round(clamp(def.y0, 0, 1) * height);
        const x1 = Math.round(clamp(def.x1, 0, 1) * width);
        const y1 = Math.round(clamp(def.y1, 0, 1) * height);
        const bbox = {
            x,
            y,
            width: Math.max(1, x1 - x),
            height: Math.max(1, y1 - y),
        };

        return {
            id: def.id,
            label: def.label,
            order: def.order,
            bbox,
        };
    });
}
