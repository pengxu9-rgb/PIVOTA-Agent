const DEFAULT_COPY_PACK = {
  intro_style_id: 'INTRO_WARM_SHORT',
  intro_text: 'Here are a few picks I think you will like.',
  headline_tmpl: 'Check out {{NAME}}',
  copy_tmpl: 'Easy to wear and simple to style.',
  highlight_tmpls: ['Soft feel', 'Versatile styling'],
};

const CREATOR_COPY_PACKS = {
  default: DEFAULT_COPY_PACK,
};

function loadCopyPack(creatorId) {
  if (!creatorId) return DEFAULT_COPY_PACK;
  return CREATOR_COPY_PACKS[creatorId] || DEFAULT_COPY_PACK;
}

module.exports = {
  DEFAULT_COPY_PACK,
  loadCopyPack,
};
