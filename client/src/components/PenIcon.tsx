/** 編集を表すペンのアイコン (右上から左下へ掛かる向き。ペン先が左下)。色は文字色に合わせる */
export function PenIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7.5 18.5 3 21l2.5-4.5Z" />
      <path d="M14.5 5.5l4 4" />
    </svg>
  );
}
