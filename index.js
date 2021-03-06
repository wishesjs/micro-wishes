const {send, json, createError} = require('micro');
const akismetAPI = require('akismet-api');
const Perspective = require('perspective-api-client');
const microCors = require('micro-cors');
const pkg = require('./package.json');

const cors = microCors({allowMethods: ['GET', 'POST', 'OPTIONS']});

const perspectiveEnabled = Boolean(process.env.PERSPECTIVE_API_KEY && process.env.PERSPECTIVE_ENABLED !== 'false');
const akismetEnabled = Boolean(process.env.AKISMET_API_KEY && process.env.AKISMET_ENABLED !== 'false');

/**
 * Catch errors from the wrapped function.
 * If any errors are caught, a JSON response is generated for that error.
 *
 * @param {function} fn: The handler function.
 * @returns {function} Decorated handler function.
 */
const handleErrors = fn => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (error) {
    if (process.env.NODE_ENV === 'dev' && error.stack) {
      console.error(error.stack);
    }
    const status = error.statusCode || 500;
    send(res, status, {
      status,
      message: error.message,
    });
  }
};

/**
 * Factory for a micro handler containing the main routing logic.
 *
 * @param {function} backend: The backend to use for the service. The backend receives the
 *  parsed input JSON from the client.
 * @param {object} attributes: Optional attributes about the backend, e.g. name, version.
 * @return {function} Micro handler.
 */
module.exports = (backend, attributes) =>
  handleErrors(
    cors(async (req, res) => {
      if (req.method === 'GET') {
        const response = {
          message:
            'Welcome to the microfeedback API. Send a POST ' +
            'request to send feedback.',
          core: {
            version: pkg.version,
            perspectiveEnabled,
            akismetEnabled,
          },
        };
        if (attributes) {
          response.backend = attributes;
        }
        send(res, 200, response);
      } else if (req.method === 'POST') {
        const input = await json(req);
        if (!input.body) {
          throw createError(422, '"body" is required in request payload');
        }
        let perspective = null;
        let akismet = null;
        if (perspectiveEnabled) {
          const perspectiveClient = new Perspective(({apiKey: process.env.PERSPECTIVE_API_KEY}));
          try {
            const response = await perspectiveClient.analyze(input.body, {truncate: true});
            const toxicity = response.attributeScores.TOXICITY.summaryScore.value;
            perspective = {toxicity};
          } catch (error) {
            console.error(error.stack || error);
          }
        }
        if (akismetEnabled) {
          const akismetClient = akismetAPI.client({
            key: process.env.AKISMET_API_KEY,
            blog: req.headers.origin,
          });
          let spam = null;
          try {
            /* eslint-disable camelcase */
            spam = await akismetClient.checkSpam({
              user_ip: req.headers['remote-addr'],
              user_agent: req.headers['user-agent'],
              referrer: req.headers.referer,
              comment_type: 'comment',
              comment_content: input.body || '',
            });
            /* eslint-enable camelcase */
          } catch (error) {
            console.error(error.stack || error);
          }
          if (spam !== null) {
            const allowSpam = Boolean(process.env.ALLOW_SPAM && process.env.ALLOW_SPAM !== 'false');
            if (spam && !allowSpam) {
              throw createError(400, 'Spam detected.');
            }
            akismet = {spam};
          }
        }
        const result = await backend({input, perspective, akismet}, req, res);
        const responseData = {result};
        if (attributes) {
          responseData.backend = attributes;
        }
        send(res, 201, responseData);
      } else {
        throw createError(405, `Method ${req.method} not allowed.`);
      }
    })
  );
