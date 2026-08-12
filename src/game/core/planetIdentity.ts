
import {
  NO_ORIGIN,
  originLabel,
  originTypeIndex,
  originHueBucket,
  type OriginTag,
} from './origin';


function letterCode(n: number): string {
  let s = '';
  let v = n;
  while (v >= 0) {
    s = String.fromCharCode(65 + (v % 26)) + s;
    v = Math.floor(v / 26) - 1;
  }
  return s;
}

const nameCache = new Map<number, string>();

export function planetName(tag: OriginTag): string {
  if (!tag || tag === NO_ORIGIN) return '';
  const hit = nameCache.get(tag);
  if (hit !== undefined) return hit;

  const typeName = originLabel(tag);
  const hue = originHueBucket(tag);
  const typeIdx = Math.max(0, originTypeIndex(tag));
  const letter = letterCode(typeName ? hue : typeIdx * 16 + hue);
  const name = typeName ? `${typeName} ${letter}` : `Planet ${letter}`;
  nameCache.set(tag, name);
  return name;
}

export function planetCode(tag: OriginTag): string {
  const name = planetName(tag);
  if (!name) return '';
  const parts = name.split(' ');
  return parts[parts.length - 1] ?? '';
}

export function displayBlockName(
  baseName: string,
  tag: OriginTag,
  planetScoped: boolean,
): string {
  if (!planetScoped || !tag || tag === NO_ORIGIN) return baseName;
  const planet = planetName(tag);
  return planet ? `${planet} ${baseName}` : baseName;
}
