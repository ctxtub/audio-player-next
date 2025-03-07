import type { AzureVoiceOption, MsVoiceOption } from '@/types/types';

export const AZURE_VOICE_OPTIONS: AzureVoiceOption[] = [
  // 中文（普通话，简体）
  { 
    value: 'zh-CN-XiaoxiaoNeural',
    label: 'Xiaoxiao',
    description: '标准女声，自然亲切',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-YunxiNeural',
    label: 'Yunxi',
    description: '标准男声，温暖有力',
    gender: 'Male',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-YunjianNeural',
    label: 'Yunjian',
    description: '标准男声，专业播报',
    gender: 'Male',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-XiaoyiNeural',
    label: 'Xiaoyi',
    description: '标准女声，温柔亲切',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-YunyangNeural',
    label: 'Yunyang',
    description: '标准男声，庄重有力',
    gender: 'Male',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-XiaochenNeural',
    label: 'Xiaochen',
    description: '标准女声，活力温暖',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-XiaochenMultilingualNeural',
    label: 'Xiaochen-M',
    description: '多语言女声，活力温暖',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-XiaohanNeural',
    label: 'Xiaohan',
    description: '标准女声，温暖亲切',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-XiaomengNeural',
    label: 'Xiaomeng',
    description: '标准女声，甜美活力',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-XiaomoNeural',
    label: 'Xiaomo',
    description: '标准女声，活泼可爱',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-XiaoqiuNeural',
    label: 'Xiaoqiu',
    description: '标准女声，温柔甜美',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-XiaorouNeural',
    label: 'Xiaorou',
    description: '标准女声，柔和亲切',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-XiaoruiNeural',
    label: 'Xiaorui',
    description: '标准女声，自然温和',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-XiaoshuangNeural',
    label: 'Xiaoshuang',
    description: '儿童女声，活泼可爱',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-XiaoxiaoDialectsNeural',
    label: 'Xiaoxiao-D',
    description: '方言女声，自然亲切',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-XiaoxiaoMultilingualNeural',
    label: 'Xiaoxiao-M',
    description: '多语言女声，自然亲切',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-XiaoyanNeural',
    label: 'Xiaoyan',
    description: '标准女声，优雅专业',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-XiaoyouNeural',
    label: 'Xiaoyou',
    description: '儿童女声，天真活泼',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-XiaoyuMultilingualNeural',
    label: 'Xiaoyu-M',
    description: '多语言女声，自然亲切',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-XiaozhenNeural',
    label: 'Xiaozhen',
    description: '标准女声，温柔细腻',
    gender: 'Female',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-YunfengNeural',
    label: 'Yunfeng',
    description: '标准男声，成熟稳重',
    gender: 'Male',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-YunhaoNeural',
    label: 'Yunhao',
    description: '标准男声，阳光活力',
    gender: 'Male',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-YunjieNeural',
    label: 'Yunjie',
    description: '标准男声，儒雅温和',
    gender: 'Male',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-YunxiaNeural',
    label: 'Yunxia',
    description: '标准男声，沉稳有力',
    gender: 'Male',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-YunyeNeural',
    label: 'Yunye',
    description: '标准男声，清朗阳光',
    gender: 'Male',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-YunyiMultilingualNeural',
    label: 'Yunyi-M',
    description: '多语言男声，自然亲切',
    gender: 'Male',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-YunzeNeural',
    label: 'Yunze',
    description: '标准男声，温和儒雅',
    gender: 'Male',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-YunfanMultilingualNeural',
    label: 'Yunfan-M',
    description: '多语言男声，自然亲切',
    gender: 'Male',
    locale: 'zh-CN'
  },
  { 
    value: 'zh-CN-YunxiaoMultilingualNeural',
    label: 'Yunxiao-M',
    description: '多语言男声，自然亲切',
    gender: 'Male',
    locale: 'zh-CN'
  },

  // 吴语（简体）
  { 
    value: 'wuu-CN-XiaotongNeural',
    label: 'Xiaotong',
    description: '吴语女声，自然亲切',
    gender: 'Female',
    locale: 'wuu-CN'
  },
  { 
    value: 'wuu-CN-YunzheNeural',
    label: 'Yunzhe',
    description: '吴语男声，温和稳重',
    gender: 'Male',
    locale: 'wuu-CN'
  },

  // 粤语（简体）
  { 
    value: 'yue-CN-XiaoMinNeural',
    label: 'XiaoMin',
    description: '粤语女声，自然亲切',
    gender: 'Female',
    locale: 'yue-CN'
  },
  { 
    value: 'yue-CN-YunSongNeural',
    label: 'YunSong',
    description: '粤语男声，温和稳重',
    gender: 'Male',
    locale: 'yue-CN'
  },

  // 地方口音普通话
  { 
    value: 'zh-CN-guangxi-YunqiNeural',
    label: 'Yunqi',
    description: '广西口音男声',
    gender: 'Male',
    locale: 'zh-CN-guangxi'
  },
  { 
    value: 'zh-CN-henan-YundengNeural',
    label: 'Yundeng',
    description: '河南口音男声',
    gender: 'Male',
    locale: 'zh-CN-henan'
  },
  { 
    value: 'zh-CN-liaoning-XiaobeiNeural',
    label: 'Xiaobei',
    description: '东北口音女声',
    gender: 'Female',
    locale: 'zh-CN-liaoning'
  },
  { 
    value: 'zh-CN-liaoning-YunbiaoNeural',
    label: 'Yunbiao',
    description: '东北口音男声',
    gender: 'Male',
    locale: 'zh-CN-liaoning'
  },
  { 
    value: 'zh-CN-shaanxi-XiaoniNeural',
    label: 'Xiaoni',
    description: '陕西口音女声',
    gender: 'Female',
    locale: 'zh-CN-shaanxi'
  },
  { 
    value: 'zh-CN-shandong-YunxiangNeural',
    label: 'Yunxiang',
    description: '山东口音男声',
    gender: 'Male',
    locale: 'zh-CN-shandong'
  },
  { 
    value: 'zh-CN-sichuan-YunxiNeural',
    label: 'Yunxi',
    description: '四川口音男声',
    gender: 'Male',
    locale: 'zh-CN-sichuan'
  },
];

// 按地区分组的 Azure 语音选项
export const AZURE_VOICE_GROUPS = {
  'zh-CN': {
    label: '中文（普通话，简体）',
    voices: AZURE_VOICE_OPTIONS.filter(v => v.locale === 'zh-CN')
  },
  'wuu-CN': {
    label: '中文（吴语，简体）',
    voices: AZURE_VOICE_OPTIONS.filter(v => v.locale === 'wuu-CN')
  },
  'yue-CN': {
    label: '中文（粤语，简体）',
    voices: AZURE_VOICE_OPTIONS.filter(v => v.locale === 'yue-CN')
  },
  'zh-CN-dialect': {
    label: '中文（地方口音）',
    voices: AZURE_VOICE_OPTIONS.filter(v => 
      ['zh-CN-guangxi', 'zh-CN-henan', 'zh-CN-liaoning', 
       'zh-CN-shaanxi', 'zh-CN-shandong', 'zh-CN-sichuan'].includes(v.locale)
    )
  }
}; 

export const MS_VOICE_OPTIONS: MsVoiceOption[] = [
  // 中文（普通话，简体）
  {
    value: 'zh-CN-XiaoxiaoNeural',
    label: 'Xiaoxiao',
    description: '标准女声，自然亲切',
    gender: 'Female',
    locale: 'zh-CN'
  },
  {
    value: 'zh-CN-XiaoyiNeural',
    label: 'Xiaoyi',
    description: '标准女声，温柔亲切',
    gender: 'Female',
    locale: 'zh-CN'
  },
  {
    value: 'zh-CN-YunjianNeural',
    label: 'Yunjian',
    description: '标准男声，专业播报',
    gender: 'Male',
    locale: 'zh-CN'
  },
  {
    value: 'zh-CN-YunxiNeural',
    label: 'Yunxi',
    description: '标准男声，温暖有力',
    gender: 'Male',
    locale: 'zh-CN'
  },
  {
    value: 'zh-CN-YunxiaNeural',
    label: 'Yunxia',
    description: '标准男声，沉稳有力',
    gender: 'Male',
    locale: 'zh-CN'
  },
  {
    value: 'zh-CN-YunyangNeural',
    label: 'Yunyang',
    description: '标准男声，庄重有力',
    gender: 'Male',
    locale: 'zh-CN'
  },
  // 中文（台湾）
  {
    value: 'zh-TW-HsiaoChenNeural',
    label: 'HsiaoChen',
    description: '台湾女声，自然亲切',
    gender: 'Female',
    locale: 'zh-TW'
  },
  {
    value: 'zh-TW-HsiaoYuNeural',
    label: 'HsiaoYu',
    description: '台湾女声，甜美活力',
    gender: 'Female',
    locale: 'zh-TW'
  },
  {
    value: 'zh-TW-YunJheNeural',
    label: 'YunJhe',
    description: '台湾男声，温和稳重',
    gender: 'Male',
    locale: 'zh-TW'
  },
  // 中文（香港）
  {
    value: 'zh-HK-HiuGaaiNeural',
    label: 'HiuGaai',
    description: '香港女声，自然亲切',
    gender: 'Female',
    locale: 'zh-HK'
  },
  {
    value: 'zh-HK-HiuMaanNeural',
    label: 'HiuMaan',
    description: '香港女声，温柔甜美',
    gender: 'Female',
    locale: 'zh-HK'
  },
  {
    value: 'zh-HK-WanLungNeural',
    label: 'WanLung',
    description: '香港男声，稳重有力',
    gender: 'Male',
    locale: 'zh-HK'
  },
  // 地方口音
  {
    value: 'zh-CN-liaoning-XiaobeiNeural',
    label: 'Xiaobei',
    description: '东北口音女声',
    gender: 'Female',
    locale: 'zh-CN-liaoning'
  },
  {
    value: 'zh-CN-shaanxi-XiaoniNeural',
    label: 'Xiaoni',
    description: '陕西口音女声',
    gender: 'Female',
    locale: 'zh-CN-shaanxi'
  }
];

// 分组定义也需要更新
export const MS_VOICE_GROUPS = {
  'zh-CN': {
    label: '中文（普通话，简体）',
    voices: MS_VOICE_OPTIONS.filter(v => v.locale === 'zh-CN')
  },
  'zh-TW': {
    label: '中文（台湾）',
    voices: MS_VOICE_OPTIONS.filter(v => v.locale === 'zh-TW')
  },
  'zh-HK': {
    label: '中文（香港）',
    voices: MS_VOICE_OPTIONS.filter(v => v.locale === 'zh-HK')
  },
  'zh-CN-dialect': {
    label: '中文（地方口音）',
    voices: MS_VOICE_OPTIONS.filter(v => 
      ['zh-CN-liaoning', 'zh-CN-shaanxi'].includes(v.locale)
    )
  }
}; 