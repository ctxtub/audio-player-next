/**
 * 头像静态资源集中导出。
 * 使用 static import 让 Next.js 生成带 hash 的路径，浏览器可永久缓存（immutable）。
 */
import avatarAssistant from '@/public/icons/avatar-assistant.jpeg';
import avatarUser from '@/public/icons/avatar-user.jpeg';
import avatarStoryAgent from '@/public/icons/avatar-story-agent.jpeg';
import avatarChatAgent from '@/public/icons/avatar-chat-agent.jpeg';
import avatarGuidanceAgent from '@/public/icons/avatar-guidance-agent.jpeg';
import avatarSummaryAgent from '@/public/icons/avatar-summary-agent.jpeg';

export {
  avatarAssistant,
  avatarUser,
  avatarStoryAgent,
  avatarChatAgent,
  avatarGuidanceAgent,
  avatarSummaryAgent,
};
