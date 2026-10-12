'use client';

import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTrigger,
  Modal,
  ModalOverlay,
} from 'react-aria-components';
import { BookOpen, Headphones, Palette, type LucideIcon } from 'lucide-react';
import GlassButton from '@/components/ui/GlassButton';
import { getSafeLocalStorage } from '@/utils/storage';
import { markOnboardingSeen, shouldShowOnboarding } from '@/utils/chatOnboarding';
import styles from './index.module.scss';

/**
 * 引导弹窗配置内容
 */
const ONBOARDING_CONFIG = {
  title: '欢迎来到故事工坊',
  steps: [
    {
      icon: Palette as LucideIcon,
      name: '选一个主题',
      desc: '从推荐主题开始，也可以直接写下你想听的故事。',
    },
    {
      icon: BookOpen as LucideIcon,
      name: '一起创作',
      desc: '告诉我们你的想法，故事会在这里逐步展开。',
    },
    {
      icon: Headphones as LucideIcon,
      name: '收听故事',
      desc: '故事准备好后，按下播放，继续收听。',
    },
  ],
  triggerGuide: '选主题、开始创作，之后就能收听自己的故事。',
  confirmButtonText: '开始体验',
};

/**
 * 聊天页新手引导弹窗
 * 跨会话持久化（localStorage）：读到版本化已读键则不再展示，以选主题、创作和收听介绍故事体验。
 */
const OnboardingModal: React.FC = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (shouldShowOnboarding(getSafeLocalStorage())) {
      setVisible(true);
    }
  }, []);

  const handleClose = () => {
    setVisible(false);
    markOnboardingSeen(getSafeLocalStorage());
  };

  return (
    <DialogTrigger isOpen={visible} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <ModalOverlay className={styles.overlay} isDismissable>
        <Modal className={styles.modalContainer}>
          <Dialog className={styles.dialog} aria-label={ONBOARDING_CONFIG.title}>
            <div className={styles.modalContent}>
              <div className={styles.header}>
                <h3>{ONBOARDING_CONFIG.title}</h3>
              </div>

              <div className={styles.agentList}>
                {ONBOARDING_CONFIG.steps.map((step) => (
                  <div key={step.name} className={styles.agentItem}>
                    <div className={styles.icon}><step.icon size={22} strokeWidth={1.8} /></div>
                    <div className={styles.agentInfo}>
                      <div className={styles.name}>{step.name}</div>
                      <div className={styles.desc}>{step.desc}</div>
                    </div>
                  </div>
                ))}
              </div>

              <div className={styles.triggerGuide}>
                <p>{ONBOARDING_CONFIG.triggerGuide}</p>
              </div>

              <div className={styles.footer}>
                <GlassButton
                  variant="primary"
                  size="lg"
                  block
                  onPress={handleClose}
                >
                  {ONBOARDING_CONFIG.confirmButtonText}
                </GlassButton>
              </div>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
};

export default OnboardingModal;
