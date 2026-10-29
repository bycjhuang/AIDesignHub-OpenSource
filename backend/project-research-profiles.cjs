'use strict';

const SYNTHETIC_LABEL = '案例调研演示假设（非实际项目指标）';
const text = (value, max = 1000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const list = value => Array.isArray(value) ? value.slice(0, 12).map(item => text(item, 800)).filter(Boolean) : [];
const numericFields = ['siteAreaM2', 'grossFloorAreaM2', 'aboveGroundAreaM2', 'belowGroundAreaM2', 'maxHeight', 'plotRatio'];

function profileSpec(project) {
  const name = text(project.name, 300), kind = `${name} ${text(project.type, 150)}`;
  if (/江湾/.test(name)) return {
    type: '滨水文化商业街区', positioning: '面向城市居民与周末访客的中型滨水文化商业中心，以“江湾客厅”为公共空间线索，结合文化展览、阅读、餐饮与社区活动。',
    siteAreaM2: 42000, aboveGroundAreaM2: 75600, belowGroundAreaM2: 26000, maxHeight: 36,
    objectives: ['形成连续可达的滨水步行界面和向公众开放的城市客厅。', '以小尺度街巷、庭院和灰空间串联商业与文化活动。', '通过主入口、雨棚、铺地及商业界面建立清晰的到达体验。', '协调工作日社区使用与周末、夜间运营，保留分期实施弹性。'],
    focusQuestions: ['哪些滨水案例能兼顾公共开放与商业运营？', '如何组织街巷、庭院、多首层与滨水步行流线？', '阅读、展览等文化空间如何成为停留节点？', '哪些材料、遮阳及雨棚做法适合上海气候与维护条件？'],
    assumptions: ['地上功能暂按商业及餐饮约60%、公共文化约25%、配套约15%进行调研比较。', '最高36米与地上计容面积均为本轮演示假设；不替代现有待确认事项或实际报规指标。', '滨水控制线、防洪标高、岸线权属、交通与停车标准需取得正式资料后核对。']
  };
  if (/文化|图书|博物|展览|艺术|剧院|活动中心/.test(kind)) return {
    type: '地方公共文化中心', positioning: '面向全年龄居民的地方文化客厅，整合展览、公共阅读、小型演艺、教育和社区共享空间。',
    siteAreaM2: 38000, aboveGroundAreaM2: 45600, belowGroundAreaM2: 14800, maxHeight: 24,
    objectives: ['用庭院与连廊组织多馆共享的公共空间。', '把地方文化转化为可持续使用的空间体验。', '兼顾平日开放、活动高峰和分区独立运营。'],
    focusQuestions: ['多功能文化建筑如何组织共享大厅及全天候公共空间？', '庭院、自然采光与地域材料如何表达地方性？', '公共开放与展陈、后勤流线如何兼容？'],
    assumptions: ['展览、阅读、演艺与教育的面积配比尚未确定，仅用于案例对比。', '运营主体、藏品及演艺技术条件需在后续取得真实委托资料。']
  };
  if (/住宅|住区|居住|社区|花园|公寓/.test(kind)) return {
    type: '改善型住宅社区', positioning: '以家庭生活、共享庭院和步行邻里为核心的中等密度改善型住宅社区。',
    siteAreaM2: 68000, aboveGroundAreaM2: 136000, belowGroundAreaM2: 52000, maxHeight: 54,
    objectives: ['构建从城市界面到组团庭院、入户空间的连续归家体验。', '平衡住宅采光、私密性、社区交往与儿童活动。', '保持人车分流，控制建筑与景观的长期维护成本。'],
    focusQuestions: ['庭院型社区如何平衡私密与邻里共享？', '归家流线与首层架空空间有哪些可迁移做法？', '住宅、公共配套和景观节点如何协同布局？'],
    assumptions: ['户型配比、套数及车位数未设为真实条件，等待正式任务书。', '住宅日照、消防、退界与停车要求需以项目所在地有效资料核对。']
  };
  if (/学校|校园|教育|幼儿园/.test(kind)) return {
    type: '教育校园', positioning: '面向日常教学与学生交流的开放学习校园，以共享学习节点和有层次的户外活动空间组织各教学组团。',
    siteAreaM2: 52000, aboveGroundAreaM2: 52000, belowGroundAreaM2: 12000, maxHeight: 24,
    objectives: ['形成安全清晰的教学、运动与后勤流线。', '用庭院、连廊及共享学习空间支持多样化教学。', '提供适合不同年龄学生的室内外过渡场所。'],
    focusQuestions: ['校园组团和共享学习空间如何形成清晰的空间秩序？', '课间活动、自然采光与全天候交通如何兼顾？', '校园对外开放空间如何与教学安防分区衔接？'],
    assumptions: ['办学规模、班级数与教学标准均待正式任务书确认。', '运动场与专用教室需求暂不作为已确认条件。']
  };
  if (/景观|公园|绿地|滨河|滨江/.test(kind)) return {
    type: '公共景观与慢行空间', positioning: '服务居民日常活动与城市访客的公共景观，以连续慢行、生态修复和可运营活动节点组织空间。',
    siteAreaM2: 96000, aboveGroundAreaM2: 4800, belowGroundAreaM2: 0, maxHeight: 9,
    objectives: ['建立无障碍、连续可达的公共慢行网络。', '协调生态基底、雨洪管理和四季活动场景。', '以小型服务设施支持长期运营与维护。'],
    focusQuestions: ['慢行线路、活动节点与生态保护如何形成整体？', '遮阴、休憩、照明及服务设施如何布点？', '哪些细部与材料适合长期公共使用和维护？'],
    assumptions: ['用地面积为概念比较假设，地形、水文与岸线资料尚未录入。', '配套建筑面积仅用于调研，不代表允许建设规模。']
  };
  return {
    type: /商业|商办|办公|产业|中心/.test(kind) ? '城市混合功能项目' : '综合公共建筑',
    positioning: `围绕“${name || '当前项目'}”的日常使用需求，研究公共空间、功能组织、城市界面与可持续运营的协同。`,
    siteAreaM2: 30000, aboveGroundAreaM2: 45000, belowGroundAreaM2: 15000, maxHeight: 36,
    objectives: ['建立清晰的公共到达、内部流线与功能分区。', '通过庭院、灰空间和开放首层提高日常使用品质。', '平衡场所识别、建设成本与长期运营维护。'],
    focusQuestions: ['同类型案例如何组织功能、公共空间与城市界面？', '哪些空间尺度和动线策略适合本项目？', '哪些材料与构造做法值得进一步技术核验？'],
    assumptions: ['项目功能配比与运营模式尚未获得正式任务书，仅作为调研比较背景。', '规划指标、技术标准和具体建设条件均须以真实资料替换。']
  };
}

function makeResearchDemoProfile(project, at = Date.now()) {
  const spec = profileSpec(project);
  return { isSynthetic: true, label: SYNTHETIC_LABEL, ...spec,
    grossFloorAreaM2: spec.aboveGroundAreaM2 + spec.belowGroundAreaM2,
    plotRatio: Number((spec.aboveGroundAreaM2 / spec.siteAreaM2).toFixed(4)),
    assumptions: ['用户授权为案例调研演示补充的虚拟基础信息，非实际项目指标，不代表业主确认、规划许可或已审批决定。', ...spec.assumptions],
    updatedAt: at };
}

// Context/export boundary: omit file paths, arbitrary objects and unknown keys.
// The synthetic marker travels with every generated numerical assumption.
function safeProfileForContext(value) {
  const profile = value?.researchProfile || value;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  const hasContent = ['positioning', 'type', ...numericFields].some(key => profile[key] !== undefined);
  if (!hasContent) return null;
  const result = { isSynthetic: profile.isSynthetic === true,
    label: profile.isSynthetic === true ? SYNTHETIC_LABEL : text(profile.label, 200) || '项目基础资料（以原始资料口径为准）' };
  for (const key of ['positioning', 'type']) { const cleaned = text(profile[key], key === 'type' ? 200 : 1500); if (cleaned) result[key] = cleaned; }
  for (const key of numericFields) if (typeof profile[key] === 'number' && Number.isFinite(profile[key]) && profile[key] >= 0 && profile[key] <= 1000000000) result[key] = profile[key];
  for (const key of ['objectives', 'focusQuestions', 'assumptions']) { const cleaned = list(profile[key]); if (cleaned.length) result[key] = cleaned; }
  if (typeof profile.updatedAt === 'number' && Number.isFinite(profile.updatedAt) && profile.updatedAt > 0) result.updatedAt = profile.updatedAt;
  else if (typeof profile.updatedAt === 'string' && profile.updatedAt.length <= 100) result.updatedAt = profile.updatedAt;
  return result;
}

function applyResearchDemoProfiles(backend) {
  if (!backend?.store || !Array.isArray(backend.store.projects) || typeof backend.mutate !== 'function') throw new Error('需要有效的本地项目后端才能补充调研演示信息。');
  const missing = backend.store.projects.filter(project => !project.researchProfile || typeof project.researchProfile === 'object' && !Object.keys(project.researchProfile).length);
  if (!missing.length) return { updatedCount: 0, skippedCount: backend.store.projects.length, updatedProjectIds: [], skippedProjectIds: backend.store.projects.map(project => project.id) };
  return backend.mutate(store => {
    const updatedProjectIds = [], skippedProjectIds = [], at = Date.now();
    for (const project of store.projects) {
      // Existing profiles, including real project information, remain the
      // owner's data. Reapplying this helper never regenerates them.
      if (project.researchProfile && (typeof project.researchProfile !== 'object' || Object.keys(project.researchProfile).length)) { skippedProjectIds.push(project.id); continue; }
      project.researchProfile = makeResearchDemoProfile(project, at); updatedProjectIds.push(project.id);
    }
    return { updatedCount: updatedProjectIds.length, skippedCount: skippedProjectIds.length, updatedProjectIds, skippedProjectIds };
  });
}

module.exports = { applyResearchDemoProfiles, safeProfileForContext, makeResearchDemoProfile, SYNTHETIC_LABEL };
