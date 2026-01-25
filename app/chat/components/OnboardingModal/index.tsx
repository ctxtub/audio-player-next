'use client';

import React, { useEffect, useState } from 'react';
import { Modal } from 'antd-mobile';
import styles from './index.module.scss';

/**
 * 引导弹窗配置内容
 */
const ONBOARDING_CONFIG = {
    title: '欢迎来到故事工坊',
    agents: [
        {
            icon: '📚',
            name: '创作Agent',
            desc: '专业的连载故事创作者，为您构思精彩情节与宏大世界观。',
        },
        {
            icon: '💬',
            name: '聊天Agent',
            desc: '解答使用疑问，陪你轻松闲聊，或协助开启新的故事篇章。',
        },
        {
            icon: '⚙️',
            name: '指令Agent',
            desc: '响应您的剧情干预请求，生成明确的系统操作指令。',
        },
    ],
    triggerGuide: '无需复杂指令，直接在这个页面与我对话，我会自动识别你的意图并召唤最合适的助手。',
    confirmButtonText: '开始体验',
};

/**
 * 聊天页新手引导弹窗
 * 仅在当前会话（Session）首次进入时展示，介绍 Available Agents 及触发方式。
 */
const OnboardingModal: React.FC = () => {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        // 检查 SessionStorage，如果未标记看过则展示
        const hasSeen = sessionStorage.getItem('chat_onboarding_seen');
        if (!hasSeen) {
            setVisible(true);
        }
    }, []);

    const handleClose = () => {
        setVisible(false);
        // 标记为已读
        sessionStorage.setItem('chat_onboarding_seen', 'true');
    };

    return (
        <Modal
            className={styles.modalContainer}
            visible={visible}
            content={
                <div className={styles.modalContent}>
                    <div className={styles.header}>
                        <h3>{ONBOARDING_CONFIG.title}</h3>
                    </div>

                    <div className={styles.agentList}>
                        {ONBOARDING_CONFIG.agents.map((agent, index) => (
                            <div key={index} className={styles.agentItem}>
                                <div className={styles.icon}>{agent.icon}</div>
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
                </div>
            }
            closeOnAction
            onClose={handleClose}
            actions={[
                {
                    key: 'confirm',
                    text: ONBOARDING_CONFIG.confirmButtonText,
                    primary: true,
                },
            ]}
        />
    );
};

export default OnboardingModal;
