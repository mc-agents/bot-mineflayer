export interface Point {
  x: number;
  y: number;
  z: number;
}

/* Every tool that reports a place reports a block, so a float position floors on the way out. */
export function blockPoint(position: Point): Point {
  return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
}
