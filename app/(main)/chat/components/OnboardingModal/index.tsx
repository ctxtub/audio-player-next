'use client';

import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTrigger,
  Modal,
  ModalOverlay,
} from 'react-aria-components';
import { BookOpen, MessageCircle, Terminal, type LucideIcon } from 'lucide-react';
import GlassButton from '@/components/ui/GlassButton';
import styles from './index.module.scss';

/**
 * 引导弹窗配置内容
 */
const ONBOARDING_CONFIG = {
  title: '欢迎来到故事工坊',
  agents: [
    {
      icon: BookOpen as LucideIcon,
      name: '创作Agent',
      desc: '专业的连载故事创作者，为您构思精彩情节与宏大世界观。',
    },
    {
      icon: MessageCircle as LucideIcon,
      name: '聊天Agent',
      desc: '解答使用疑问，陪你轻松闲聊，或协助开启新的故事篇章。',
    },
    {
      icon: Terminal as LucideIcon,
      name: '指令Agent',
      desc: '响应您的剧情干预请求，生成明确的系统操作指令。',
    },
  ],
  triggerGuide: '无需复杂操作，直接在这个页面与我对话，我会自动识别你的意图并召唤最合适的Agent。',
  confirmButtonText: '开始体验',
};

/**
 * 聊天页新手引导弹窗
 * 仅在当前会话（Session）首次进入时展示，介绍 Available Agents 及触发方式。
 */
const OnboardingModal: React.FC = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const hasSeen = sessionStorage.getItem('chat_onboarding_seen');
    if (!hasSeen) {
      setVisible(true);
    }
  }, []);

  const handleClose = () => {
    setVisible(false);
    sessionStorage.setItem('chat_onboarding_seen', 'true');
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
                {ONBOARDING_CONFIG.agents.map((agent, index) => (
                  <div key={index} className={styles.agentItem}>
                    <div className={styles.icon}><agent.icon size={22} strokeWidth={1.8} /></div>
                    <div className={styles.agentInfo}>
                      <div className={styles.name}>{agent.name}</div>
                      <div className={styles.desc}>{agent.desc}</div>
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
