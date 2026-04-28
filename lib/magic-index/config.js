'use strict';

function yes(value) {
  return /^(yes|true|1|on)$/i.test(String(value || ''));
}

function getMagicIndexConfig(env = process.env) {
  const provider = env.MAGICINDEX_PROVIDER || 'off';
  const providerPrivate = yes(env.MAGICINDEX_PROVIDER_PRIVATE || 'no');
  const defaultProvider = env.MAGICINDEX_PROVIDER_DEFAULT || provider;
  return {
    provider,
    provider_default: defaultProvider,
    provider_private: providerPrivate,
    default_enabled: provider !== 'off' && providerPrivate,
    auto_apply_confidence: Number(env.MAGICINDEX_AUTO_APPLY_CONFIDENCE || 0.85),
    max_pages: Number(env.MAGICINDEX_MAX_PAGES || 2),
    max_chars: Number(env.MAGICINDEX_MAX_CHARS || 12000),
    openai: {
      model: env.MAGICINDEX_OPENAI_MODEL || 'gpt-5.4-nano',
      api_key: env.OPENAI_API_KEY || env.MAGICINDEX_OPENAI_API_KEY || '',
      send_pdf_input: !/^(no|false|0|off)$/i.test(String(env.MAGICINDEX_OPENAI_SEND_PDF || 'yes'))
    },
    compatible: {
      base_url: env.MAGICINDEX_COMPAT_BASE_URL || '',
      model: env.MAGICINDEX_COMPAT_MODEL || '',
      api_key: env.MAGICINDEX_COMPAT_API_KEY || ''
    }
  };
}

module.exports = { getMagicIndexConfig, yes };
