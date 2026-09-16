import { redirect } from 'next/navigation';

/**
 *  /player 兼容入口：最薄 server redirect（route ownership 已切换至 /library）。
 * 旧 Player UI（index.tsx / components/**）物理保留至，但此后不可达。
 */
export default function PlayerCompatPage() {
  redirect('/library');
}
