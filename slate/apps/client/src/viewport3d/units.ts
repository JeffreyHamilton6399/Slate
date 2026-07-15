/**
 * Real-world units for the 3D viewport (CAD mode).
 *
 * The scene's canonical scale is 1 world unit = 1 meter (three.js
 * convention); display units are a per-device preference converted at the
 * UI edge, so collaborators can each read the same model in mm / inches.
 */

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

export const LENGTH_UNITS: { id: LengthUnit; label: string }[] = [
  { id: 'mm', label: 'Millimeters' },
  { id: 'cm', label: 'Centimeters' },
  { id: 'm', label: 'Meters' },
  { id: 'in', label: 'Inches' },
  { id: 'ft', label: 'Feet' },
];

const UNIT_PER_METER: Record<LengthUnit, number> = {
  mm: 1000,
  cm: 100,
  m: 1,
  in: 39.37007874,
  ft: 3.280839895,
};

export function metersToUnit(meters: number, unit: LengthUnit): number {
  return meters * UNIT_PER_METER[unit];
}

export function unitToMeters(value: number, unit: LengthUnit): number {
  return value / UNIT_PER_METER[unit];
}

/** Sensible input/display precision per unit (mm needs fewer decimals). */
export function unitDecimals(unit: LengthUnit): number {
  return unit === 'mm' ? 1 : unit === 'cm' ? 2 : 3;
}

/** Format a length in the chosen unit, with feet+inches for ft and a
 *  readable label. e.g. 1.8 m → "5′ 11″" (ft) or "70.866 in" (in). */
export function formatLength(meters: number, unit: LengthUnit): string {
  if (unit === 'ft') {
    const totalIn = meters * 39.37007874;
    const ft = Math.floor(totalIn / 12);
    const inch = totalIn - ft * 12;
    return `${ft}′ ${inch.toFixed(1)}″`;
  }
  return `${metersToUnit(meters, unit).toFixed(unitDecimals(unit))} ${unit}`;
}

/** Format an area given in m² to the chosen display unit. e.g. 0.5 m² →
 *  "5000.0 cm²" (cm) or "5.382 ft²" (ft). Uses 1 extra decimal for area
 *  since values are usually small. */
export function formatArea(metersSquared: number, unit: LengthUnit): string {
  const factor = UNIT_PER_METER[unit];
  const value = metersSquared * factor * factor;
  const decimals = unit === 'mm' ? 0 : unit === 'cm' ? 1 : unit === 'm' ? 3 : 2;
  return `${value.toFixed(decimals)} ${unit}²`;
}
