'use client';

import { Dialog, Modal, ModalOverlay } from 'react-aria-components';
import styles from './creationConfirmation.module.scss';

/** Confirm switching the active editor while keeping its unsent draft. */
export function ConversationSwitchConfirmation({
  open,
  collectionTitle,
  resolve,
}: {
  open: boolean;
  collectionTitle: string;
  resolve: (approved: boolean) => void;
}) {
  if (!open) return null;
  return (
    <ModalOverlay
      className={styles.overlay}
      isOpen
      onOpenChange={(value) => { if (!value) resolve(false); }}
      isDismissable
    >
      <Modal className={styles.modal}>
        <Dialog aria-label="切换创作" className={styles.dialog}>
          <h2>切换到《{collectionTitle}》？</h2>
          <p>当前输入会保留。正在生成的内容会先完成并保存，再进入这份创作；不会自动生成新故事。</p>
          <div>
            <button autoFocus type="button" onClick={() => resolve(false)}>留在当前创作</button>
            <button type="button" onClick={() => resolve(true)}>保留草稿并切换</button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
