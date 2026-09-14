import { redirect } from 'next/navigation';

/**
 * M9-01 /player 兼容入口：最薄 server redirect（route ownership 已切换至 /library）。
 * 旧 Player UI（index.tsx / components/**）物理保留至 M9-02，但此后不可达。
 */
export default function PlayerCompatPage() {
  redirect('/library');
}
