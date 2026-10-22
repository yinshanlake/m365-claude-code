const catalog = require('./models.json');
const aliases = new Map(catalog.models.flatMap(model =>
  [model.id, ...model.aliases].map(alias => [alias, model.id])));

function resolveModel(value) {
  if (typeof value === 'string') {
    const requested = value.trim().toLowerCase();
    const model = aliases.get(requested.startsWith('m365,') ? requested.slice(5) : requested);
    if (model) return model;
  }
  const display = typeof value === 'string' ? value.slice(0, 160) : '(missing model)';
  throw Object.assign(new Error('Unsupported M365 model "' + display +
    '". Use /model to select a configured M365 route. No fallback was used.'), {
    statusCode: 400,
    type: 'invalid_request_error',
  });
}

// Request bodies are authoritative. Legacy launch headers cannot pin a session.
module.exports = async request => 'm365,' + resolveModel(request.body?.model);
module.exports.resolveModel = resolveModel;
module.exports.catalog = catalog;
