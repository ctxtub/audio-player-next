'use client';
import { Dialog, Modal, ModalOverlay } from 'react-aria-components';
import styles from './creationConfirmation.module.scss';
/** 新建前只确认未保存内容，使用可访问的应用内对话框。 */
export function CreationConfirmation({ open, resolve }: { open: boolean; resolve: (approved: boolean) => void }) {
  if (!open) return null;
  return <ModalOverlay className={styles.overlay} isOpen onOpenChange={(value) => { if (!value) resolve(false); }} isDismissable>
    <Modal className={styles.modal}><Dialog aria-label="新建故事集" className={styles.dialog}>
      <h2>开始新故事集？</h2><p>未保存内容将被清空，当前收听和自动创作会停止。已保存的故事会保留。</p>
      <div><button autoFocus onClick={() => resolve(false)}>继续当前创作</button><button onClick={() => resolve(true)}>开始新故事集</button></div>
    </Dialog></Modal>
  </ModalOverlay>;
}
