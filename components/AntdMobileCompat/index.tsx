'use client';

import { useEffect } from 'react';
import { unstableSetRender } from 'antd-mobile';
import { createRoot, type Root } from 'react-dom/client';

/**
 * 扩充容器以缓存 React Root，适配 antd-mobile 自定义渲染。
 */
type CompatContainer = HTMLElement & { _reactRoot?: Root };

/**
 * 表示兼容配置是否已执行，避免重复挂载。
 */
let configured = false;

/**
 * antd-mobile 在 Next.js 中的兼容组件，注入自定义渲染逻辑。
 */
export function AntdMobileCompat() {
  useEffect(() => {
    if (configured) {
      return;
    }

    unstableSetRender((node, container) => {
      const compatContainer = container as CompatContainer;
      compatContainer._reactRoot ||= createRoot(container);
      const root = compatContainer._reactRoot;
      root.render(node);

      return async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        root.unmount();
      };
    });

    configured = true;
  }, []);

  return null;
}
