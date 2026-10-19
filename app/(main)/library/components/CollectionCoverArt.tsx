'use client';

import React from 'react';
import styles from './libraryComponents.module.scss';

export interface CollectionCoverArtProps {
  title: string;
  collectionId?: string;
  size?: 'sm' | 'md' | 'lg';
  isPlaying?: boolean;
  className?: string;
}

type CoverTheme = 'lighthouse' | 'forest' | 'celestial' | 'horizon' | 'ocean' | 'hearth';

const THEMES: CoverTheme[] = [
  'lighthouse',
  'forest',
  'celestial',
  'horizon',
  'ocean',
  'hearth',
];

function resolveCoverTheme(seed: string): CoverTheme {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  if (/鲸|珊瑚|深海|湖|水|雨|溪|泉|鱼/.test(seed)) return 'ocean';
  if (/灯塔|海|潮|岛|港|船/.test(seed)) return 'lighthouse';
  if (/林|森|树|山|雾|谷|鹿|松/.test(seed)) return 'forest';
  if (/星|月|夜|梦|宇宙|银河|云/.test(seed)) return 'celestial';
  if (/车|轨|旅|巷|钟楼|城|街/.test(seed)) return 'horizon';
  return THEMES[hash % THEMES.length];
}

/**
 * 纯矢量 SVG 故事集封面插画组件（零 Emoji，多层渐变与几何光影贴图）。
 */
export const CollectionCoverArt: React.FC<CollectionCoverArtProps> = ({
  title,
  collectionId = '',
  size = 'md',
  isPlaying = false,
  className = '',
}) => {
  const seed = `${title}-${collectionId}`;
  const theme = resolveCoverTheme(seed);
  const uid = React.useId().replace(/:/g, '');

  const sizeClass =
    size === 'lg'
      ? styles.coverArtLg
      : size === 'sm'
        ? styles.coverArtSm
        : styles.coverArtMd;

  return (
    <div
      className={`${styles.coverArt} ${sizeClass} ${isPlaying ? styles.coverArtPlaying : ''} ${className}`}
      aria-hidden="true"
      data-cover-theme={theme}
    >
      <svg
        viewBox="0 0 96 96"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={styles.coverSvg}
      >
        <defs>
          {theme === 'lighthouse' && (
            <>
              <linearGradient id={`bg-${uid}`} x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#1e1b4b" />
                <stop offset="55%" stopColor="#312e81" />
                <stop offset="100%" stopColor="#4c1d95" />
              </linearGradient>
              <linearGradient id={`beam-${uid}`} x1="48" y1="28" x2="92" y2="14" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#fde68a" stopOpacity="0.65" />
                <stop offset="100%" stopColor="#fde68a" stopOpacity="0" />
              </linearGradient>
            </>
          )}
          {theme === 'forest' && (
            <>
              <linearGradient id={`bg-${uid}`} x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#0f2926" />
                <stop offset="55%" stopColor="#134e4a" />
                <stop offset="100%" stopColor="#1e293b" />
              </linearGradient>
              <radialGradient id={`glow-${uid}`} cx="50%" cy="32%" r="45%">
                <stop offset="0%" stopColor="#5eead4" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#5eead4" stopOpacity="0" />
              </radialGradient>
            </>
          )}
          {theme === 'celestial' && (
            <>
              <linearGradient id={`bg-${uid}`} x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#17153b" />
                <stop offset="50%" stopColor="#2e236c" />
                <stop offset="100%" stopColor="#4338ca" />
              </linearGradient>
              <radialGradient id={`glow-${uid}`} cx="65%" cy="30%" r="45%">
                <stop offset="0%" stopColor="#c4b5fd" stopOpacity="0.4" />
                <stop offset="100%" stopColor="#c4b5fd" stopOpacity="0" />
              </radialGradient>
            </>
          )}
          {theme === 'horizon' && (
            <>
              <linearGradient id={`bg-${uid}`} x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#1e1b4b" />
                <stop offset="55%" stopColor="#4c1d95" />
                <stop offset="100%" stopColor="#7c2d12" />
              </linearGradient>
              <radialGradient id={`glow-${uid}`} cx="50%" cy="62%" r="42%">
                <stop offset="0%" stopColor="#fdba74" stopOpacity="0.4" />
                <stop offset="100%" stopColor="#fdba74" stopOpacity="0" />
              </radialGradient>
            </>
          )}
          {theme === 'ocean' && (
            <>
              <linearGradient id={`bg-${uid}`} x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#0c2d48" />
                <stop offset="55%" stopColor="#145374" />
                <stop offset="100%" stopColor="#1e3a8a" />
              </linearGradient>
              <radialGradient id={`glow-${uid}`} cx="50%" cy="40%" r="45%">
                <stop offset="0%" stopColor="#7dd3fc" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#7dd3fc" stopOpacity="0" />
              </radialGradient>
            </>
          )}
          {theme === 'hearth' && (
            <>
              <linearGradient id={`bg-${uid}`} x1="0" y1="0" x2="96" y2="96" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#3b1d38" />
                <stop offset="55%" stopColor="#581c87" />
                <stop offset="100%" stopColor="#78350f" />
              </linearGradient>
              <radialGradient id={`glow-${uid}`} cx="50%" cy="45%" r="45%">
                <stop offset="0%" stopColor="#fcd34d" stopOpacity="0.38" />
                <stop offset="100%" stopColor="#fcd34d" stopOpacity="0" />
              </radialGradient>
            </>
          )}
        </defs>

        {/* 背景底板 */}
        <rect width="96" height="96" rx="18" fill={`url(#bg-${uid})`} />

        {/* 主题 1：星夜灯塔 */}
        {theme === 'lighthouse' && (
          <g>
            <path d="M46 28L94 8V42L46 32Z" fill={`url(#beam-${uid})`} />
            <path d="M46 28L2 14V38L46 32Z" fill={`url(#beam-${uid})`} opacity="0.55" />
            <circle cx="22" cy="20" r="1.5" fill="#fef3c7" opacity="0.9" />
            <circle cx="74" cy="18" r="1.3" fill="#e0e7ff" opacity="0.8" />
            <circle cx="66" cy="34" r="1.1" fill="#e0e7ff" opacity="0.6" />
            <path d="M26 15L27 18L30 19L27 20L26 23L25 20L22 19L25 18Z" fill="#fde68a" opacity="0.85" />
            {/* 灯塔塔身 */}
            <path d="M41 68L43.5 34H48.5L51 68H41Z" fill="#e0e7ff" fillOpacity="0.92" />
            <path d="M42.3 48H49.7L50.3 55H41.7L42.3 48Z" fill="#6366f1" />
            <rect x="42" y="27" width="8" height="7" rx="2" fill="#fde68a" />
            <path d="M40 27L46 21L52 27H40Z" fill="#c7d2fe" />
            {/* 海浪层 */}
            <path
              d="M0 72C16 66 32 76 48 70C64 64 80 74 96 68V96H0V72Z"
              fill="#312e81"
              fillOpacity="0.85"
            />
            <path
              d="M0 80C18 75 34 84 52 78C68 73 82 81 96 77V96H0V80Z"
              fill="#1e1b4b"
              fillOpacity="0.9"
            />
          </g>
        )}

        {/* 主题 2：迷雾松林 */}
        {theme === 'forest' && (
          <g>
            <circle cx="48" cy="32" r="36" fill={`url(#glow-${uid})`} />
            <circle cx="68" cy="24" r="7" fill="#ccfbf1" fillOpacity="0.85" />
            {/* 远山 */}
            <path d="M0 70L26 44L52 66L76 46L96 64V96H0V70Z" fill="#115e59" fillOpacity="0.55" />
            {/* 松树群 */}
            <path d="M32 34L20 56H26L18 72H46L38 56H44L32 34Z" fill="#5eead4" fillOpacity="0.85" />
            <path d="M58 40L48 58H53L46 72H70L63 58H68L58 40Z" fill="#2dd4bf" fillOpacity="0.7" />
            {/* 萤火微光 */}
            <circle cx="22" cy="30" r="1.6" fill="#99f6e4" opacity="0.9" />
            <circle cx="46" cy="24" r="1.3" fill="#fde68a" opacity="0.85" />
            <circle cx="76" cy="42" r="1.5" fill="#99f6e4" opacity="0.75" />
            <path d="M0 74C24 69 48 77 72 72C82 70 90 72 96 74V96H0V74Z" fill="#0f172a" fillOpacity="0.75" />
          </g>
        )}

        {/* 主题 3：星轨弯月 */}
        {theme === 'celestial' && (
          <g>
            <circle cx="58" cy="30" r="38" fill={`url(#glow-${uid})`} />
            <ellipse
              cx="48"
              cy="50"
              rx="34"
              ry="14"
              transform="rotate(-22 48 50)"
              stroke="#a5b4fc"
              strokeOpacity="0.4"
              strokeWidth="1.5"
              strokeDasharray="3 3"
            />
            {/* 弯月 */}
            <path
              d="M56 22C45.5 22 37 30.5 37 41C37 51.5 45.5 60 56 60C60.5 60 64.6 58.4 67.8 55.8C60.4 56.6 53.8 51.2 53 43.8C52.2 36.4 57.2 29.8 64.4 28.4C61.8 24.4 59.1 22 56 22Z"
              fill="#fde68a"
            />
            {/* 星座连线 */}
            <path
              d="M20 64L32 54L46 62L64 48"
              stroke="#c7d2fe"
              strokeOpacity="0.55"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
            <circle cx="20" cy="64" r="2" fill="#e0e7ff" />
            <circle cx="32" cy="54" r="2.2" fill="#fde68a" />
            <circle cx="46" cy="62" r="1.8" fill="#e0e7ff" />
            <circle cx="64" cy="48" r="2.2" fill="#c4b5fd" />
            <path d="M24 24L25.2 27.5L28.7 28.7L25.2 29.9L24 33.4L22.8 29.9L19.3 28.7L22.8 27.5Z" fill="#fde68a" />
          </g>
        )}

        {/* 主题 4：暮色列车与拱桥 */}
        {theme === 'horizon' && (
          <g>
            <circle cx="48" cy="56" r="36" fill={`url(#glow-${uid})`} />
            <circle cx="48" cy="44" r="14" fill="#fdba74" fillOpacity="0.88" />
            {/* 流星线 */}
            <path d="M20 22L38 30" stroke="#fde68a" strokeWidth="1.6" strokeLinecap="round" opacity="0.8" />
            <circle cx="38" cy="30" r="2" fill="#fef3c7" />
            {/* 远景拱桥轮廓 */}
            <path
              d="M0 62H96V76H86C86 69 76 69 76 76H62C62 69 52 69 52 76H38C38 69 28 69 28 76H14C14 69 4 69 4 76H0V62Z"
              fill="#1e1b4b"
              fillOpacity="0.9"
            />
            {/* 水面倒影波纹 */}
            <rect x="0" y="74" width="96" height="22" fill="#0f172a" fillOpacity="0.85" />
            <line x1="34" y1="81" x2="62" y2="81" stroke="#fdba74" strokeOpacity="0.55" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="40" y1="86" x2="56" y2="86" stroke="#fdba74" strokeOpacity="0.35" strokeWidth="1.5" strokeLinecap="round" />
          </g>
        )}

        {/* 主题 5：深海声波与明珠 */}
        {theme === 'ocean' && (
          <g>
            <circle cx="48" cy="40" r="36" fill={`url(#glow-${uid})`} />
            <circle cx="48" cy="38" r="11" fill="#bae6fd" fillOpacity="0.9" />
            <circle cx="48" cy="38" r="17" stroke="#7dd3fc" strokeOpacity="0.35" strokeWidth="1.2" />
            {/* 声波曲线 */}
            <path
              d="M8 60C22 50 34 70 48 60C62 50 74 70 88 60"
              stroke="#38bdf8"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
            <path
              d="M8 70C22 60 34 80 48 70C62 60 74 80 88 70"
              stroke="#7dd3fc"
              strokeOpacity="0.6"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <circle cx="24" cy="26" r="2" stroke="#bae6fd" strokeOpacity="0.7" strokeWidth="1.2" />
            <circle cx="72" cy="28" r="2.5" stroke="#bae6fd" strokeOpacity="0.6" strokeWidth="1.2" />
          </g>
        )}

        {/* 主题 6：暖炉故事书 */}
        {theme === 'hearth' && (
          <g>
            <circle cx="48" cy="42" r="36" fill={`url(#glow-${uid})`} />
            {/* 展开的书本矢量轮廓 */}
            <path
              d="M22 42C22 39 33 37 46 41V67C33 63 22 65 22 68V42Z"
              fill="#fef3c7"
              fillOpacity="0.9"
            />
            <path
              d="M74 42C74 39 63 37 50 41V67C63 63 74 65 74 68V42Z"
              fill="#fde68a"
              fillOpacity="0.85"
            />
            {/* 书页上方升起的星芒与声波 */}
            <path d="M48 18L50 24L56 26L50 28L48 34L46 28L40 26L46 24Z" fill="#fcd34d" />
            <circle cx="34" cy="28" r="1.8" fill="#fde68a" opacity="0.8" />
            <circle cx="62" cy="26" r="1.8" fill="#fde68a" opacity="0.8" />
          </g>
        )}

        {/* 玻璃高光内边框 */}
        <rect
          x="0.75"
          y="0.75"
          width="94.5"
          height="94.5"
          rx="17.25"
          stroke="white"
          strokeOpacity="0.16"
          strokeWidth="1.5"
        />
      </svg>

      {/* 播放中动态声波指示器（纯 SVG/CSS，无 Emoji） */}
      {isPlaying ? (
        <span className={styles.coverPlayingIndicator}>
          <span className={styles.waveBar} />
          <span className={styles.waveBar} />
          <span className={styles.waveBar} />
        </span>
      ) : null}
    </div>
  );
};
