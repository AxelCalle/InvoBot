const express = require('express');
const router = express.Router();
const config = require('../../config');

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    env: config.nodeEnv,
    timestamp: new Date().toISOString(),
    services: {
      whatsapp: !!config.whatsapp.token,
      claude: !!config.anthropic.apiKey,
      siscon: !!config.siscon.apiKey,
    },
  });
});

module.exports = router;
