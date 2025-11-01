'use client';

import { useEffect } from 'react';
import { unstableSetRender } from 'antd-mobile';
import { createRoot, type Root } from 'react-dom/client';

type CompatContainer = HTMLElement & { _reactRoot?: Root };

let configured = false;

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
