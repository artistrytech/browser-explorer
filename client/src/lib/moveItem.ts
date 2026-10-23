/** from 番目の要素を挿入位置 to (0..length、元の並びでの隙間) へ移す (ドラッグでの並び替え) */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, item);
  return next;
}
