import React from 'react';
import { Form, Input } from 'antd-mobile';
import styles from '../index.module.scss';

/**
 * 将输入转换为正整数，非法输入返回 0。
 * @param value 表单值。
 */
const parsePositiveInteger = (value: number | string | undefined): number => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
};

/**
 * 基础配置区域：只负责播放时长的输入校验。
 */
const BasicConfigSection: React.FC = () => (
  <div className={styles.configSection}>
    <h3>基础配置</h3>
    <Form.Item
      name="playDuration"
      label="播放时长（分钟）"
      rules={[
        { required: true, message: '请输入播放时长' },
        {
          validator: (_, value) => {
            const parsed = parsePositiveInteger(value);
            if (parsed <= 0) {
              return Promise.reject(new Error('请输入有效的播放时长'));
            }
            return Promise.resolve();
          },
        },
      ]}
    >
      <Input type="number" placeholder="30" min={1} />
    </Form.Item>
  </div>
);

export default BasicConfigSection;
