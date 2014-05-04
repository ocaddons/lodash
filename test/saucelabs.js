#!/usr/bin/env node
'use strict';

/** Environment shortcut */
var env = process.env;

if (isFinite(env.TRAVIS_PULL_REQUEST)) {
  console.log('Skipping Sauce Labs jobs for pull requests');
  process.exit(0);
}

/** Load Node.js modules */
var EventEmitter = require('events').EventEmitter,
    http = require('http'),
    path = require('path'),
    url = require('url'),
    util = require('util');

/** Load other modules */
var _ = require('../lodash.js'),
    chalk = require('chalk'),
    ecstatic = require('ecstatic'),
    request = require('request'),
    SauceTunnel = require('sauce-tunnel-sc3-1');

/** Used for Sauce Labs credentials */
var accessKey = env.SAUCE_ACCESS_KEY,
    username = env.SAUCE_USERNAME;

/** Used as the default maximum number of times to retry a job and tunnel */
var maxJobRetries = 3,
    maxTunnelRetries = 3;

/** Used as the static file server middleware */
var mount = ecstatic({
  'cache': false,
  'root': process.cwd()
});

/** Used as the list of ports supported by Sauce Connect */
var ports = [
  80, 443, 888, 2000, 2001, 2020, 2109, 2222, 2310, 3000, 3001, 3030, 3210,
  3333, 4000, 4001, 4040, 4321, 4502, 4503, 4567, 5000, 5001, 5050, 5555, 5432,
  6000, 6001, 6060, 6666, 6543, 7000, 7070, 7774, 7777, 8000, 8001, 8003, 8031,
  8080, 8081, 8765, 8777, 8888, 9000, 9001, 9080, 9090, 9876, 9877, 9999, 49221,
  55001
];

/** Used by `logInline` to clear previously logged messages */
var prevLine = '';

/** Method shortcut */
var push = Array.prototype.push;

/** Used to detect error messages */
var reError = /\berror\b/i;

/** Used to display the wait throbber */
var throbberDelay = 500,
    waitCount = -1;

/** Used as Sauce Labs config values */
var advisor = getOption('advisor', true),
    build = getOption('build', (env.TRAVIS_COMMIT || '').slice(0, 10)),
    compatMode = getOption('compatMode', null),
    customData = Function('return {' + getOption('customData', '').replace(/^\{|}$/g, '') + '}')(),
    framework = getOption('framework', 'qunit'),
    idleTimeout = getOption('idleTimeout', 180),
    jobName = getOption('name', 'unit tests'),
    maxDuration = getOption('maxDuration', 360),
    port = ports[Math.min(_.sortedIndex(ports, getOption('port', 9001)), ports.length - 1)],
    publicAccess = getOption('public', true),
    queueTimeout = getOption('queueTimeout', 360),
    recordVideo = getOption('recordVideo', true),
    recordScreenshots = getOption('recordScreenshots', false),
    runner = getOption('runner', 'test/index.html').replace(/^\W+/, ''),
    runnerUrl = getOption('runnerUrl', 'http://localhost:' + port + '/' + runner),
    statusInterval = getOption('statusInterval', 5000),
    tags = getOption('tags', []),
    throttled = getOption('throttled', 10),
    tunneled = getOption('tunneled', true),
    tunnelId = getOption('tunnelId', 'tunnel_' + (env.TRAVIS_JOB_NUMBER || 0)),
    tunnelTimeout = getOption('tunnelTimeout', 10000),
    videoUploadOnPass = getOption('videoUploadOnPass', false);

/** Used to convert Sauce Labs browser identifiers to their formal names */
var browserNameMap = {
  'googlechrome': 'Chrome',
  'iehta': 'Internet Explorer',
  'ipad': 'iPad',
  'iphone': 'iPhone'
};

/** List of platforms to load the runner on */
var platforms = [
  ['Linux', 'android', '4.3'],
  ['Linux', 'android', '4.0'],
  ['Windows 8.1', 'firefox', '28'],
  ['Windows 8.1', 'firefox', '27'],
  ['Windows 8.1', 'firefox', '20'],
  ['Windows 8.1', 'firefox', '3.0'],
  ['Windows 8.1', 'googlechrome', '34'],
  ['Windows 8.1', 'googlechrome', '33'],
  ['Windows 8.1', 'internet explorer', '11'],
  ['Windows 8', 'internet explorer', '10'],
  ['Windows 7', 'internet explorer', '9'],
  ['Windows 7', 'internet explorer', '8'],
  ['Windows XP', 'internet explorer', '7'],
  ['Windows XP', 'internet explorer', '6'],
  ['Windows 7', 'opera', '12'],
  ['Windows 7', 'opera', '11'],
  ['OS X 10.9', 'ipad', '7.1'],
  ['OS X 10.9', 'safari', '7'],
  ['OS X 10.8', 'safari', '6'],
  ['OS X 10.6', 'safari', '5']
];

/** Used to tailor the `platforms` array */
var runnerQuery = url.parse(runner, true).query,
    isBackbone = /\bbackbone\b/i.test(runner),
    isModern = /\bmodern\b/i.test(runnerQuery.build);

// platforms to test IE compat mode
if (compatMode) {
  platforms = [
    ['Windows 8.1', 'internet explorer', '11'],
    ['Windows 8', 'internet explorer', '10'],
    ['Windows 7', 'internet explorer', '9'],
    ['Windows 7', 'internet explorer', '8']
  ];
}
// platforms for AMD tests
if (_.contains(tags, 'amd')) {
  platforms = _.filter(platforms, function(platform) {
    var browser = browserName(platform[1]),
        version = +platform[2];

    if (browser == 'Opera') {
      return version >= 10;
    }
    return true;
  });
}
// platforms for Backbone tests
if (isBackbone) {
  platforms = _.filter(platforms, function(platform) {
    var browser = browserName(platform[1]),
        version = +platform[2];

    switch (browser) {
      case 'Firefox': return version >= 4;
      case 'Opera': return version >= 12;
    }
    return true;
  });
}
// platforms for modern builds
if (isModern) {
  platforms = _.filter(platforms, function(platform) {
    var browser = browserName(platform[1]),
        version = +platform[2];

    switch (browser) {
      case 'Android': return version >= 4.1;
      case 'Firefox': return version >= 10;
      case 'Internet Explorer': return version >= 9;
      case 'Opera': return version >= 12;
      case 'Safari': return version >= 6;
    }
    return true;
  });
}

/** Used as the default `Job` options object */
var jobOptions = {
  'build': build,
  'custom-data': customData,
  'framework': framework,
  'idle-timeout': idleTimeout,
  'max-duration': maxDuration,
  'name': jobName,
  'public': publicAccess,
  'platforms': platforms,
  'record-screenshots': recordScreenshots,
  'record-video': recordVideo,
  'sauce-advisor': advisor,
  'tags': tags,
  'url': runnerUrl,
  'video-upload-on-pass': videoUploadOnPass
};

if (publicAccess === true) {
  jobOptions['public'] = 'public';
}
if (tunneled) {
  jobOptions['tunnel-identifier'] = tunnelId;
}

/*----------------------------------------------------------------------------*/

/**
 * Resolves the formal browser name for a given Sauce Labs browser identifier.
 *
 * @private
 * @param {string} identifier The browser identifier.
 * @returns {string} Returns the formal browser name.
 */
function browserName(identifier) {
  return browserNameMap[identifier] || capitalizeWords(identifier);
}

/**
 * Capitalizes the first character of each word in `string`.
 *
 * @private
 * @param {string} string The string to augment.
 * @returns {string} Returns the augmented string.
 */
function capitalizeWords(string) {
  return _.map(string.split(' '), _.capitalize).join(' ');
}

/**
 * Gets the value for the given option name. If no value is available the
 * `defaultValue` is returned.
 *
 * @private
 * @param {string} name The name of the option.
 * @param {*} defaultValue The default option value.
 * @returns {*} Returns the option value.
 */
function getOption(name, defaultValue) {
  var isArr = _.isArray(defaultValue);
  return _.reduce(process.argv, function(result, value) {
    if (isArr) {
      value = optionToArray(name, value);
      return _.isEmpty(value) ? result : value;
    }
    value = optionToValue(name, value);

    return value == null ? result : value;
  }, defaultValue);
}

/**
 * Writes an inline message to standard output.
 *
 * @private
 * @param {string} [text=''] The text to log.
 */
function logInline(text) {
  var blankLine = _.repeat(' ', _.size(prevLine));
  prevLine = text = _.truncate(text, 40);
  process.stdout.write(text + blankLine.slice(text.length) + '\r');
}

/**
 * Writes the wait throbber to standard output.
 *
 * @private
 */
function logThrobber() {
  logInline('Please wait' + _.repeat('.', (++waitCount % 3) + 1));
}

/**
 * Converts a comma separated option value into an array.
 *
 * @private
 * @param {string} name The name of the option to inspect.
 * @param {string} string The options string.
 * @returns {Array} Returns the new converted array.
 */
function optionToArray(name, string) {
  return _.compact(_.invoke((optionToValue(name, string) || '').split(/, */), 'trim'));
}

/**
 * Extracts the option value from an option string.
 *
 * @private
 * @param {string} name The name of the option to inspect.
 * @param {string} string The options string.
 * @returns {string|undefined} Returns the option value, else `undefined`.
 */
function optionToValue(name, string) {
  var result = (result = string.match(RegExp('^' + name + '(?:=([\\s\\S]+))?$'))) && (result[1] ? result[1].trim() : true);
  if (result === 'false') {
    return false;
  }
  return result || undefined;
}

/*----------------------------------------------------------------------------*/

/**
 * The `request.post` callback used by `Jobs#start`.
 *
 * @private
 * @param {Object} [error] The error object.
 * @param {Object} res The response data object.
 * @param {Object} body The response body JSON object.
 */
function onJobStart(error, res, body) {
  var id = _.result(body, 'js tests', [])[0],
      statusCode = _.result(res, 'statusCode'),
      tunnel = this.tunnel;

  this.starting = false;
  if (this.stopping || tunnel.starting) {
    return;
  }
  if (error || !id || statusCode != 200) {
    if (this.attempts < this.retries) {
      this.restart();
      return;
    }
    logInline();
    console.error('Failed to start job; status: %d, body:\n%s', statusCode, JSON.stringify(body));
    if (error) {
      console.error(error);
    }
    this.failed = true;
    this.emit('complete');
    return;
  }
  this.id = id;
  this.running = true;
  this.timestamp = _.now();
  this.emit('start');
  this.status();
}

/**
 * The `request.post` callback used by `Job#status`.
 *
 * @private
 * @param {Object} [error] The error object.
 * @param {Object} res The response data object.
 * @param {Object} body The response body JSON object.
 */
function onJobStatus(error, res, body) {
  var data = _.result(body, 'js tests', [{}])[0],
      jobStatus = data.status,
      options = this.options,
      platform = options.platforms[0],
      result = data.result,
      completed = _.result(body, 'completed'),
      description = browserName(platform[1]) + ' ' + platform[2] + ' on ' + capitalizeWords(platform[0]),
      elapsed = (_.now() - this.timestamp) / 1000,
      expired = (jobStatus != 'test session in progress' && elapsed >= queueTimeout),
      failures = _.result(result, 'failed'),
      label = options.name + ':',
      tunnel = this.tunnel,
      url = data.url;

  this.checking = false;
  if (!this.running || this.stopping) {
    return;
  }
  this.emit('status', jobStatus);

  if (!completed && !expired) {
    this.statusId = setTimeout(_.bind(this.status, this), this.statusInterval);
    return;
  }
  this.result = result;
  this.url = url;

  if (!result || failures || reError.test(result.message)) {
    if (this.attempts < this.retries) {
      this.restart();
      return;
    }
    var details = 'See ' + url + ' for details.';
    this.failed = true;

    logInline();
    if (failures) {
      console.error(label + ' %s ' + chalk.red('failed') + ' %d test' + (failures > 1 ? 's' : '') + '. %s', description, failures, details);
    }
    else if (tunnel.attempts < tunnel.retries) {
      tunnel.restart();
      return;
    }
    else {
      var message = _.result(result, 'message', 'no results available. ' + details);
      console.error(label, description, chalk.red('failed') + ';', message);
    }
  } else {
    console.log(label, description, chalk.green('passed'));
  }
  this.running = false;
  this.emit('complete');
}

/**
 * The `request.put` callback used by `Jobs#stop`.
 *
 * @private
 */
function onJobStop() {
  this.running = this.stopping = false;
  if (!this.tunnel.starting) {
    this.emit('stop');
  }
}

/**
 * The `SauceTunnel#start` callback used by `Tunnel#start`.
 *
 * @private
 * @param {boolean} success The connection success indicator.
 */
function onTunnelStart(success) {
  this.starting = false;
  if (!success) {
    if (this.attempts < this.retries) {
      this.restart();
      return;
    }
    console.error('Failed to open Sauce Connect tunnel');
    process.exit(2);
  }
  console.log('Sauce Connect tunnel opened');

  var jobs = this.jobs;
  push.apply(jobs.queue, jobs.all);

  this.running = true;
  this.emit('start');

  console.log('Starting jobs...');
  this.dequeue();
}

/**
 * The `SauceTunnel#stop` callback used by `Tunnel#stop`.
 *
 * @private
 * @param {Object} [error] The error object.
 */
function onTunnelStop(error) {
  this.running = this.stopping = false;
  this.emit('stop', error);
}

/*----------------------------------------------------------------------------*/

/**
 * The Job constructor.
 *
 * @private
 * @param {Object} [properties] The properties to initialize a job with.
 */
function Job(properties) {
  EventEmitter.call(this);

  this.options = {};
  this.retries = maxJobRetries;
  this.statusInterval = statusInterval;

  _.merge(this, properties);
  _.defaults(this.options, _.cloneDeep(jobOptions));

  this.attempts = 0;
  this.checking = false;
  this.failed = false;
  this.running = false;
  this.starting = false;
  this.stopping = false;
}

util.inherits(Job, EventEmitter);

/**
 * Resets the job.
 *
 * @memberOf Job
 * @param {Function} callback The function called once the job is reset.
 * @param {Object} Returns the job instance.
 */
Job.prototype.reset = function(callback) {
  if (this.running) {
    return this.stop(_.partial(this.reset, callback));
  }
  this.attempts = 0;
  this.failed = false;
  this.id = this.result = this.url = null;

  this.once('start', _.callback(callback, this));
  _.defer(_.bind(this.emit, this, 'reset'));

  return this;
};

/**
 * Restarts the job.
 *
 * @memberOf Job
 * @param {Function} callback The function called once the job is restarted.
 * @param {Object} Returns the job instance.
 */
Job.prototype.restart = function(callback) {
  var options = this.options,
      platform = options.platforms[0],
      description = browserName(platform[1]) + ' ' + platform[2] + ' on ' + capitalizeWords(platform[0]),
      label = options.name + ':';

  logInline();
  console.log(label + ' ' + description + ' restart #%d of %d', ++this.attempts, this.retries);

  _.defer(_.bind(this.emit, this, 'restart'));
  this.stop(_.partial(this.start, callback));

  return this;
};

/**
 * Starts the job.
 *
 * @memberOf Job
 * @param {Function} callback The function called once the job is started.
 * @param {Object} Returns the job instance.
 */
Job.prototype.start = function(callback) {
  var tunnel = this.tunnel;

  this.once('start', _.callback(callback, this));
  if (this.starting || this.running || tunnel.starting || tunnel.stopping) {
    return this;
  }
  this.starting = true;
  request.post(_.template('https://saucelabs.com/rest/v1/${user}/js-tests', this), {
    'auth': { 'user': this.user, 'pass': this.pass },
    'json': this.options
  }, _.bind(onJobStart, this));

  return this;
};

/**
 * Checks the status of a job.
 *
 * @memberOf Job
 * @param {Function} callback The function called once the status is resolved.
 * @param {Object} Returns the job instance.
 */
Job.prototype.status = function(callback) {
  var tunnel = this.tunnel;

  this.once('status', _.callback(callback, this));
  if (this.checking || this.starting || this.stopping || tunnel.starting || tunnel.stopping) {
    return this;
  }
  this.checking = true;
  request.post(_.template('https://saucelabs.com/rest/v1/${user}/js-tests/status', this), {
    'auth': { 'user': this.user, 'pass': this.pass },
    'json': { 'js tests': [this.id] }
  }, _.bind(onJobStatus, this));

  return this;
};

/**
 * Stops the job.
 *
 * @memberOf Job
 * @param {Function} callback The function called once the job is stopped.
 * @param {Object} Returns the job instance.
 */
Job.prototype.stop = function(callback) {
  this.once('stop', _.callback(callback, this));
  if (this.stopping || this.tunnel.starting) {
    return this;
  }
  var onStop = _.bind(onJobStop, this);

  this.stopping = true;
  if (this.statusId) {
    this.checking = false;
    this.statusId = clearTimeout(this.statusId);
  }
  if (this.id == null || !this.running) {
    _.defer(onStop);
    return this;
  }
  request.put(_.template('https://saucelabs.com/rest/v1/${user}/jobs/${id}/stop', this), {
    'auth': { 'user': this.user, 'pass': this.pass }
  }, onStop);

  return this;
};

/*----------------------------------------------------------------------------*/

/**
 * The Tunnel constructor.
 *
 * @private
 * @param {Object} [properties] The properties to initialize the tunnel with.
 */
function Tunnel(properties) {
  EventEmitter.call(this);

  this.retries = maxTunnelRetries;
  _.merge(this, properties);

  this.attempts = 0;
  this.running = false;
  this.starting = false;
  this.stopping = false;

  var active = [],
      queue = [];

  var all = _.map(this.platforms, function(platform) {
    return new Job(_.merge({
      'user': this.user,
      'pass': this.pass,
      'tunnel': this,
      'options': { 'platforms': [platform] }
    }, this.job));
  }, this);

  var completed = 0,
      restarted = [],
      success = true,
      total = all.length,
      tunnel = this;

  _.invoke(all, 'on', 'complete', function() {
    _.pull(active, this);
    if (success) {
      success = !this.failed;
    }
    if (++completed == total) {
      tunnel.running = false;
      tunnel.emit('complete', success);
      return;
    }
    tunnel.dequeue();
  });

  _.invoke(all, 'on', 'restart', function() {
    if (!_.contains(restarted, this)) {
      restarted.push(this);
    }
    // restart tunnel if all active jobs have restarted
    if (_.isEmpty(_.difference(active, restarted))) {
      tunnel.restart();
    }
  });

  this.on('stop', function() {
    completed = 0;
    success = true;
    restarted.length = 0;
    _.invoke(all, 'reset');
  });

  this.jobs = { 'active': active, 'all': all, 'queue': queue };
  this.connection = new SauceTunnel(this.user, this.pass, this.id, this.tunneled, this.timeout);
}

util.inherits(Tunnel, EventEmitter);

/**
 * Restarts the tunnel.
 *
 * @memberOf Tunnel
 * @param {Function} callback The function called once the tunnel is restarted.
 */
Tunnel.prototype.restart = function(callback) {
  logInline();
  console.log('Tunnel ' + this.id + ': restart #%d of %d', ++this.attempts, this.retries);

  _.defer(_.bind(this.emit, this, 'restart'));
  this.stop(_.partial(this.start, callback));

  return this;
};

/**
 * Starts the tunnel.
 *
 * @memberOf Tunnel
 * @param {Function} callback The function called once the tunnel is started.
 * @param {Object} Returns the tunnel instance.
 */
Tunnel.prototype.start = function(callback) {
  this.once('start', _.callback(callback, this));
  if (!(this.starting || this.running)) {
    console.log('Opening Sauce Connect tunnel...');
    this.starting = true;
    this.connection.start(_.bind(onTunnelStart, this));
  }
  return this;
};

/**
 * Removes jobs from the queue and starts them.
 *
 * @memberOf Tunnel
 * @param {Object} Returns the tunnel instance.
 */
Tunnel.prototype.dequeue = function() {
  var jobs = this.jobs,
      active = jobs.active,
      queue = jobs.queue,
      throttled = this.throttled;

  while (queue.length && (active.length < throttled)) {
    active.push(queue.shift().start());
  }
  return this;
};

/**
 * Stops the tunnel.
 *
 * @memberOf Tunnel
 * @param {Function} callback The function called once the tunnel is stopped.
 * @param {Object} Returns the tunnel instance.
 */
Tunnel.prototype.stop = function(callback) {
  this.once('stop', _.callback(callback, this));
  if (this.stopping) {
    return this;
  }
  console.log('Shutting down Sauce Connect tunnel...');

  var jobs = this.jobs,
      active = jobs.active,
      onStop = _.bind(onTunnelStop, this),
      stopped = 0,
      total = active.length,
      tunnel = this;

  this.stopping = true;
  jobs.queue.length = 0;

  if (!total || !this.running) {
    _.defer(onStop);
    return this;
  }
  _.invoke(active, 'stop', function() {
    _.pull(active, this);
    if (++stopped == total) {
      tunnel.connection.stop(onStop);
    }
  });

  return this;
};

/*----------------------------------------------------------------------------*/

// cleanup any inline logs when exited via `ctrl+c`
process.on('SIGINT', function() {
  logInline();
  process.exit();
});

// create a web server for the current working directory
http.createServer(function(req, res) {
  // see http://msdn.microsoft.com/en-us/library/ff955275(v=vs.85).aspx
  if (compatMode && path.extname(url.parse(req.url).pathname) == '.html') {
    res.setHeader('X-UA-Compatible', 'IE=' + compatMode);
  }
  mount(req, res);
}).listen(port);

// set up Sauce Connect so we can use this server from Sauce Labs
var tunnel = new Tunnel({
  'user': username,
  'pass': accessKey,
  'id': tunnelId,
  'job': { 'retries': maxJobRetries, 'statusInterval': statusInterval },
  'platforms': platforms,
  'retries': maxTunnelRetries,
  'throttled': throttled,
  'tunneled': tunneled,
  'timeout': tunnelTimeout
});

tunnel.on('complete', function(success) {
  this.stop(function() { process.exit(success ? 0 : 1); });
});

tunnel.start();

setInterval(logThrobber, throbberDelay);
