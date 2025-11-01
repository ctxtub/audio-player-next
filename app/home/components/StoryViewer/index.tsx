import React from 'react';
import Modal, { useModal } from '../../../../components/Modal';
import styles from './index.module.scss';

interface StoryViewerProps {
  storyList: string[] | string;
}

const StoryViewer: React.FC<StoryViewerProps> = ({ storyList }) => {
  const storyText = Array.isArray(storyList) ? storyList.join('\n') : storyList;
  const { isShow, showModal, closeModal } = useModal();
  
  const renderStoryContent = () => {
    return (
      <div className={styles.storyText}>
        {
          Array.isArray(storyList) ? (
            storyList.map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))
          ) : (
            <p>{storyText}</p>
          )
        }
      </div>
    );
  };
  
  return (
    <>
      {storyText && (
        <div className={styles.storyPreview} onClick={showModal}>
          <p className={styles.storyPreviewText}>{storyText.slice(0, 100)}...</p>
          <button className={styles.readMore}>查看全文</button>
        </div>
      )}

      <Modal
        isShow={isShow}
        title="故事全文"
        onClose={closeModal}
      >
        {renderStoryContent()}
      </Modal>
    </>
  );
};

export default StoryViewer;