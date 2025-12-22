function safeLower(s) {
  return String(s || '').toLowerCase();
}

function detectUseCase(rawQuery) {
  const q = String(rawQuery || '');
  const lower = safeLower(q);

  const has = (re) => re.test(q) || re.test(lower);

  if (has(/眼线刷|贴根部|填充睫毛根部|アイライナーブラシ|tightline|eyeliner brush|pinceau eye-?liner|pincel delineador/i))
    return 'liner';
  if (has(/下眼睑刷|卧蚕|下まぶた|lower lash|ras de cils inférieur|línea inferior/i))
    return 'lower';
  if (has(/烟熏刷|烟熏|スマッジャー|smudger|smoky|pinceau smoky|smoky/i)) return 'smoky';
  if (has(/眼窝刷|褶皱|クリース|crease brush|pinceau creux|cuenca/i)) return 'crease';
  if (has(/晕染刷|过渡刷|晕染|ぼかし|blending brush|blend|estompeur|difuminador/i)) return 'blend';
  if (has(/铺色刷|显色|亮片|平筆|flat shader|packing|aplicador|pinceau plat/i)) return 'pack';

  return 'general';
}

const BRUSH_TYPES = {
  FLAT_SHADER: {
    name: {
      zh: 'FLAT_SHADER（铺色刷/平铺刷）',
      en: 'FLAT_SHADER (flat shader / packing brush)',
      ja: 'FLAT_SHADER（平筆/シェーダー）',
      fr: 'FLAT_SHADER (pinceau plat)',
      es: 'FLAT_SHADER (pincel plano)',
    },
    purpose: {
      zh: '按压/轻扫铺色打底，更显色。',
      en: 'Packs color on the lid for stronger payoff.',
      ja: 'まぶたに色を乗せて発色を上げる。',
      fr: 'Applique la couleur sur la paupière, plus de pigmentation.',
      es: 'Aplica color en el párpado con más pigmentación.',
    },
  },
  BLENDING: {
    name: {
      zh: 'BLENDING（晕染刷/过渡刷）',
      en: 'BLENDING (blending brush)',
      ja: 'BLENDING（ブレンディング/ぼかし）',
      fr: 'BLENDING (pinceau estompeur)',
      es: 'BLENDING (pincel difuminador)',
    },
    purpose: {
      zh: '柔化边界、做过渡渐层。',
      en: 'Softens edges and blends transitions.',
      ja: '境目をぼかしてグラデにする。',
      fr: 'Estompe les bords et fait les transitions.',
      es: 'Difumina bordes y transiciones.',
    },
  },
  CREASE_TAPERED: {
    name: {
      zh: 'CREASE_TAPERED（眼窝刷/锥形晕染）',
      en: 'CREASE_TAPERED (crease / tapered blender)',
      ja: 'CREASE_TAPERED（クリース/テーパード）',
      fr: 'CREASE_TAPERED (creux / effilé)',
      es: 'CREASE_TAPERED (cuenca / cónico)',
    },
    purpose: {
      zh: '更精准地加深眼窝、控制范围。',
      en: 'Adds definition in the crease with control.',
      ja: 'アイホールに立体感、範囲をコントロール。',
      fr: 'Définit le creux avec plus de contrôle.',
      es: 'Define la cuenca con control.',
    },
  },
  PENCIL_DETAIL: {
    name: {
      zh: 'PENCIL_DETAIL（铅笔刷/细节刷）',
      en: 'PENCIL_DETAIL (pencil / detail brush)',
      ja: 'PENCIL_DETAIL（鉛筆/ディテール）',
      fr: 'PENCIL_DETAIL (pinceau crayon)',
      es: 'PENCIL_DETAIL (pincel lápiz)',
    },
    purpose: {
      zh: '外眼角/下眼睑细节加深，点涂更好控。',
      en: 'Targets small areas (outer corner, lower lashline).',
      ja: '目尻/下まぶたの細部に。',
      fr: 'Pour les détails (coin externe, ligne inférieure).',
      es: 'Para detalles (esquina externa, línea inferior).',
    },
  },
  SMUDGER: {
    name: {
      zh: 'SMUDGER（烟熏刷/晕开刷）',
      en: 'SMUDGER (smudge brush)',
      ja: 'SMUDGER（スマッジャー）',
      fr: 'SMUDGER (smoky court)',
      es: 'SMUDGER (smoky corto)',
    },
    purpose: {
      zh: '把深色/眼线晕成雾感，做烟熏。',
      en: 'Smudges liner/shadow for a smoky effect.',
      ja: 'ラインや濃い色をぼかしてスモーキーに。',
      fr: 'Floute le trait pour un effet smoky.',
      es: 'Difumina para efecto ahumado.',
    },
  },
  LINER_FINE: {
    name: {
      zh: 'LINER_FINE（眼线刷/极细勾勒）',
      en: 'LINER_FINE (fine liner brush)',
      ja: 'LINER_FINE（極細ライナー）',
      fr: 'LINER_FINE (eye-liner fin)',
      es: 'LINER_FINE (delineador fino)',
    },
    purpose: {
      zh: '画眼线/贴根部填充，线条更干净。',
      en: 'Creates a crisp line or tightlines the lash base.',
      ja: 'アイライン・まつ毛際をきれいに埋める。',
      fr: 'Trace fin / tightline à la racine des cils.',
      es: 'Línea fina o rellenar la raíz de pestañas.',
    },
  },
  ANGLED_SHADER: {
    name: {
      zh: 'ANGLED_SHADER（斜角铺色/V区）',
      en: 'ANGLED_SHADER (angled shader)',
      ja: 'ANGLED_SHADER（斜め）',
      fr: 'ANGLED_SHADER (biseauté)',
      es: 'ANGLED_SHADER (biselado)',
    },
    purpose: {
      zh: '外眼角V区、眼尾提拉更顺手。',
      en: 'Shapes the outer V and lifts the tail.',
      ja: '目尻のV字やリフトに。',
      fr: 'Travaille le coin externe (V) et lifte.',
      es: 'Trabaja la V externa y eleva el rabillo.',
    },
  },
  LOWER_LASH_SMALL: {
    name: {
      zh: 'LOWER_LASH_SMALL（下眼睑/卧蚕）',
      en: 'LOWER_LASH_SMALL (lower lash small blender)',
      ja: 'LOWER_LASH_SMALL（下まぶた用）',
      fr: 'LOWER_LASH_SMALL (petit estompeur)',
      es: 'LOWER_LASH_SMALL (pequeño para línea inferior)',
    },
    purpose: {
      zh: '下眼睑小范围晕染，不容易脏。',
      en: 'Blends small areas on the lower lashline cleanly.',
      ja: '下まぶたを小さくきれいにぼかす。',
      fr: 'Estompe finement la ligne inférieure.',
      es: 'Difumina fino en la línea inferior.',
    },
  },
};

function t(lang, dict) {
  return dict[lang] || dict.en;
}

function buildFollowUps(lang, useCase) {
  const qs = [];
  if (useCase === 'general') {
    qs.push(
      t(lang, {
        zh: '你主要想解决哪种用途：①铺色显色 ②过渡晕染 ③眼尾加深/眼窝 ④下眼睑/卧蚕 ⑤画眼线/贴根部？',
        en: 'What do you want it for: pack color / blend / deepen crease or outer corner / lower lashline / eyeliner-tighting?',
        ja: '目的はどれ？：発色（乗せる）/ ぼかし / 目尻・アイホール / 下まぶた / アイライン・まつ毛際',
        fr: 'Tu le veux surtout pour : poser la couleur / estomper / intensifier creux ou coin externe / ligne inférieure / eye-liner ?',
        es: '¿Para qué lo quieres: aplicar color / difuminar / intensificar cuenca o esquina externa / línea inferior / delinear?',
      }),
    );
    qs.push(
      t(lang, {
        zh: '你是新手还是比较熟练？（或：单眼皮/内双/外双/肿泡眼/眼窝深 哪个更像你？选一个即可）',
        en: 'Are you a beginner, or what’s your eye type (monolid/hooded/deep-set/small)?',
        ja: '初心者？それとも目のタイプは（単眼/奥二重/二重/くぼみ/腫れぼったい）どれ？',
        fr: 'Tu es débutant(e) ? Ton type d’œil : mono / tombante / creusé / petit ?',
        es: '¿Eres principiante? Tipo de ojo: monólido / encapotado / hundido / pequeño?',
      }),
    );
    return qs.slice(0, 2);
  }

  if (useCase === 'blend') {
    qs.push(
      t(lang, {
        zh: '你想要“自然清透渐层”还是“更深更烟熏”的晕染？',
        en: 'Do you want a soft everyday gradient or a deeper smoky blend?',
        ja: 'ナチュラルなグラデ？それとも濃いめのスモーキー？',
        fr: 'Plutôt un dégradé naturel ou un smoky plus profond ?',
        es: '¿Degradado natural o ahumado más intenso?',
      }),
    );
    return qs.slice(0, 1);
  }

  if (useCase === 'pack') {
    qs.push(
      t(lang, {
        zh: '你更常用粉状眼影，还是膏/霜/亮片偏多？',
        en: 'Do you mostly use powder shadows, or creams/shimmers/glitters?',
        ja: 'パウダー中心？それともクリーム/ラメが多い？',
        fr: 'Tu utilises surtout des fards poudre ou plutôt crème/irisés/paillettes ?',
        es: '¿Usas más sombras en polvo o crema/brillos/glitter?',
      }),
    );
    return qs.slice(0, 1);
  }

  if (useCase === 'lower') {
    qs.push(
      t(lang, {
        zh: '你想做“轻微自然放大”还是“明显下眼影强调”？',
        en: 'Do you want a subtle lower-lash enhancement or a more defined lower shadow?',
        ja: '下まぶたは“さりげなく” or “しっかり強調”どっち？',
        fr: 'Tu veux un effet discret ou bien marqué sur la ligne inférieure ?',
        es: '¿Un efecto sutil o marcado en la línea inferior?',
      }),
    );
    return qs.slice(0, 1);
  }

  if (useCase === 'liner') {
    qs.push(
      t(lang, {
        zh: '你用的是凝胶/膏状眼线，还是用深色眼影当眼线？',
        en: 'Do you use gel/cream liner, or shadow-as-liner?',
        ja: 'ジェル/クリームライナー？それとも濃いシャドウをライナー代わり？',
        fr: 'Tu utilises un eye-liner gel/crème, ou un fard en guise d’eye-liner ?',
        es: '¿Delineador en gel/crema o sombra como delineador?',
      }),
    );
    return qs.slice(0, 1);
  }

  if (useCase === 'smoky') {
    qs.push(
      t(lang, {
        zh: '你想要偏“轻微雾感”还是“更浓的烟熏”？',
        en: 'Do you want a soft haze or a heavier smoky look?',
        ja: 'ふんわりスモーク？それとも濃いめのスモーキー？',
        fr: 'Un smoky léger ou bien plus intense ?',
        es: '¿Ahumado suave o más intenso?',
      }),
    );
    return qs.slice(0, 1);
  }

  return [];
}

function recommendBrushTypes(useCase) {
  if (useCase === 'blend') return ['BLENDING', 'CREASE_TAPERED'];
  if (useCase === 'pack') return ['FLAT_SHADER', 'BLENDING'];
  if (useCase === 'crease') return ['CREASE_TAPERED', 'BLENDING'];
  if (useCase === 'lower') return ['LOWER_LASH_SMALL', 'PENCIL_DETAIL'];
  if (useCase === 'liner') return ['LINER_FINE', 'SMUDGER'];
  if (useCase === 'smoky') return ['SMUDGER', 'BLENDING'];
  return ['BLENDING', 'FLAT_SHADER', 'LOWER_LASH_SMALL'];
}

function buildBuyingTips(lang, useCase) {
  const tips = [];
  tips.push(
    t(lang, {
      zh: '尺寸：内双/小眼睛优先小号（更好控范围）。',
      en: 'Size: small/hooded eyes usually do better with smaller heads.',
      ja: 'サイズ：小さめの目/奥二重は小さめが失敗しにくい。',
      fr: 'Taille : petits yeux/paupière tombante → tête plus petite.',
      es: 'Tamaño: ojos pequeños/encapotados → cabezal más pequeño.',
    }),
  );
  tips.push(
    t(lang, {
      zh: '密度：想显色选更密的平刷；想柔和选更蓬松的晕染刷。',
      en: 'Density: denser flats pack pigment; fluffier brushes blend softer.',
      ja: '密度：密=発色、ふわ=ぼかし。',
      fr: 'Densité : dense = pigmentation, fluffy = fondu.',
      es: 'Densidad: denso = pigmento, suelto = difuminado.',
    }),
  );
  if (useCase === 'pack') {
    tips.push(
      t(lang, {
        zh: '亮片/膏霜：更推荐合成纤维（更稳、更好清洁）。',
        en: 'Shimmers/creams: synthetic bristles tend to work better and clean easier.',
        ja: 'ラメ/クリーム系は合成毛が扱いやすい。',
        fr: 'Irisés/crèmes : les poils synthétiques sont souvent plus stables.',
        es: 'Brillos/cremas: el pelo sintético suele ir mejor y se limpia fácil.',
      }),
    );
  }
  return tips.slice(0, 4);
}

function buildEyeShadowBrushReply({ rawQuery, language }) {
  const lang = ['zh', 'en', 'ja', 'fr', 'es'].includes(language) ? language : 'en';
  const useCase = detectUseCase(rawQuery);
  const types = recommendBrushTypes(useCase);

  const lines = [];
  lines.push(
    t(lang, {
      zh: '你在选“眼影刷/眼部刷”，我只按眼部刷型来推荐（不会扩展到全脸刷具套装）。',
      en: "You’re picking an eyeshadow/eye brush—I’ll stay strictly on eye brushes (no full-face kits).",
      ja: 'アイシャドウ（目元）ブラシの話として、目元用だけで提案するね（全顔のブラシセットには広げません）。',
      fr: "On parle bien de pinceaux pour les yeux—je reste sur les pinceaux yeux uniquement (pas de kits visage).",
      es: 'Hablamos de pinceles de ojos: me quedo solo en pinceles de ojos (sin kits de rostro).',
    }),
  );

  // If the user already implied a use case, give a small, actionable recommendation now.
  lines.push(
    t(lang, {
      zh: '\n先给你一个不踩雷的最小组合：',
      en: '\nA safe minimal pick:',
      ja: '\nまず失敗しにくい最小構成：',
      fr: '\nUn minimum sûr :',
      es: '\nUn mínimo seguro:',
    }),
  );
  for (const id of types.slice(0, 3)) {
    const meta = BRUSH_TYPES[id];
    if (!meta) continue;
    lines.push(`- ${t(lang, meta.name)}：${t(lang, meta.purpose)}`);
  }

  lines.push(
    t(lang, {
      zh: '\n选购要点（快速版）：',
      en: '\nQuick buying tips:',
      ja: '\n選び方（要点）：',
      fr: "\nConseils d’achat rapides :",
      es: '\nConsejos rápidos de compra:',
    }),
  );
  for (const tip of buildBuyingTips(lang, useCase)) lines.push(`- ${tip}`);

  const qs = buildFollowUps(lang, useCase);
  if (qs.length) {
    lines.push(
      t(lang, {
        zh: '\n想更精准的话，回答 1–2 个就行：',
        en: '\nTo refine, answer 1–2 quick questions:',
        ja: '\nもっと絞り込むなら、1〜2個だけ答えて：',
        fr: '\nPour affiner, réponds à 1–2 questions :',
        es: '\nPara afinar, responde 1–2 preguntas:',
      }),
    );
    for (const q of qs.slice(0, 2)) lines.push(`- ${q}`);
  }

  return { reply: lines.join('\n'), use_case: useCase };
}

module.exports = {
  buildEyeShadowBrushReply,
  _debug: { detectUseCase },
};
