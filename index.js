var http = require('http'),
    http_server = http.createServer(httpRouter),
    io = require('socket.io').listen(http_server),
    fs = require('fs'),
		url = require('url'),
    Handlebars = require('handlebars'),
		cookie = require('cookie');

/////////////////////////////////////////////////////////////////////////
// Load Config

var HTTPD_PORT = process.env.PORT || 8090,
    // How long should we wait between frames?
    REFRESH_INTERVAL = process.env.REFRESH_INTERVAL || 15000,
    // Spew debug messages. Spew.
    DEBUG = ('TRUE' === (process.env.DEBUG || 'FALSE')),
    // Where do we connect to socket.io?
    SOCKETIO_HOST = process.env.SOCKETIO_HOST || '/',
    // Where should files be served from?
    WEB_ROOT;

if( DEBUG ) {
  console.log(' ===== Configuration Summary =====');
  console.log(' =                HTTPD_PORT:', HTTPD_PORT);
  console.log(' =          REFRESH_INTERVAL:', REFRESH_INTERVAL);
  console.log(' =             SOCKETIO_HOST:', SOCKETIO_HOST);
	io.configure(function () {
		io.set('log level', 1);
	});
}
else {
	io.configure(function () {
		io.enable('browser client minification');
		io.enable('browser client etag');
		io.enable('browser client gzip');
		io.set('log level', 1);
	});
}

/////////////////////////////////////////////////////////////////////////
// Util

// Array Remove - By John Resig (MIT Licensed)
Array.prototype.remove = function(from, to) {
  var rest = this.slice((to || from) + 1 || this.length);
  this.length = from < 0 ? this.length + from : from;
  return this.push.apply(this, rest);
};

// content-type detection for lazy bums
var extensions_content_types = {'jpg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif',	'css': 'text/css', 'js': 'application/javascript'};

function content_type_for_path ( path ) {
  var match = path.match(/\.([a-z0-4]*)$/);
  if( null === match ) { return 'application/octet-stream'; }
  return extensions_content_types[match[1]];
}

function timestamp () { return +new Date(); }

/////////////////////////////////////////////////////////////////////////
// Users

var users = {};
var urls = {};

function doesUserExist (username) {
	return users.hasOwnProperty(username);
}

function ensureUserExists (username) {
	if( ! doesUserExist(username) ) {
		users[username] = {
			connections: 0,
			away: false,
			last_update: timestamp()
		};
	}
}

function connectUser (username) {
	ensureUserExists(username);
	users[username].connections++;
}

function disconnectUser (username) {
	if( doesUserExist(username) ) {
		if( 0 >= --users[username].connections ) {
			delete users[username];
			delete urls[username];
			return true;
		}
		return false;
	}
	return true;
}

function setUserURL (username, url) {
	ensureUserExists(username);
	users[username].last_update = timestamp();
	urls[username] = url;
}

function getUserState (username) {
	ensureUserExists(username);
	return users[username];
}

function getUserURL (username) {
	if( urls.hasOwnProperty(username) ) {
		return urls[username];
	}
	return null;
}

function markUserAway (username) {
	ensureUserExists(username);
	users[username].away = true;
}

function markUserAvailable (username) {
	ensureUserExists(username);
	users[username].away = false;
}

function cleanUpStaleUsers () {
	var removed_usernames = [], now = timestamp(), username;
	for(username in users) {
		if( users.hasOwnProperty(username) ) {
			if( now - users[username].last_update > REFRESH_INTERVAL * 4 ) {
				delete users[username];
				delete urls[username];
				removed_usernames.push(username);
			}
		}
	}
	return removed_usernames;
}

/////////////////////////////////////////////////////////////////////////
// Templates

var template_cache = {};

function get_compiled_template (name) {
	if( ! template_cache.hasOwnProperty(name) ) {
		var data = fs.readFileSync('./templates/' + name + '.html', {encoding: 'utf8'});
		template_cache[name] = Handlebars.compile(data);
  }
	return template_cache[name];
}


function render_template(name, context) {
	var tmpl = get_compiled_template(name);
	return tmpl(context);	
}

/////////////////////////////////////////////////////////////////////////
// HTTP Server

/**
 * Serve an arbitrary file from the WEB_ROOT directory.
 */
function serveFile ( response, path ) {
  fs.realpath(WEB_ROOT + path, function (err, resolved_path) {

    if( undefined === resolved_path ) {
      response.writeHead(404, {'Content-Type': 'text/plain'});
      response.end('404 - Not Found');
      return;
    }

    if( err ) {
      response.writeHead(500, {'Content-Type': 'text/plain'});
      response.end('500 - Internal Server Error');
      return;
    }

    // stay in the web root
    if( 0 !== resolved_path.indexOf(WEB_ROOT) ) {
      response.writeHead(403, {'Content-Type': 'text/plain'});
      response.end('403 - Forbidden');
      return;
    }

    fs.readFile(resolved_path, function read(err, data) {
      if (err) {
        response.writeHead(500, {'Content-Type': 'text/plain'});
        response.end('500 - Internal Server Error');
      }
      response.writeHead(200, {"Content-Type": content_type_for_path(resolved_path), "Content-Length": data.length});
      response.end(data, 'binary');
    });
  });
}

/////////////////////////////////////////////////////////////////////////
// HTTP Server

function httpRouter (request, response) {
  if( DEBUG ) { console.log('Incoming Request:', request.url); }

	var parsed_url = url.parse(request.url, true);

  if(parsed_url.pathname === '/') {

		var rendered_template, context = {};

		var cookies = (request.headers.hasOwnProperty('cookie')) ? cookie.parse(request.headers.cookie) : {};

		if( parsed_url.query.hasOwnProperty('username') && parsed_url.query.username.length > 0) {
			context = {
				SOCKETIO_HOST: SOCKETIO_HOST,
				REFRESH_INTERVAL: REFRESH_INTERVAL,
				asciify: parsed_url.query.hasOwnProperty('ascii'),
				username: parsed_url.query.username
			};

			response.setHeader('Set-Cookie', cookie.serialize('last_used_username', parsed_url.query.username));

			rendered_template = render_template('index', context);
		}
		else {
			if( cookies.hasOwnProperty('last_used_username') ) {
				context.last_used_username = cookies.last_used_username;
			}
			rendered_template = render_template('connect', context);
		}

		response.writeHead(200, {"Content-Type": 'text/html', "Content-Length": rendered_template.length});
		response.end(rendered_template);
  }
	else if (parsed_url.pathname === '/image') {
		var user_url = getUserURL(parsed_url.query.username);
		if( user_url !== null ) {
			response.writeHead(200, {'Content-Type': 'text/json'});
			response.end(JSON.stringify({url: user_url}));
		}
		else {
			response.writeHead(404, {'Content-Type': 'text/plain'});
			response.end('Not Found');
		}
	}
	else if (parsed_url.pathname === '/update' && request.method === "POST") {
		var username = parsed_url.query.username;
    var img = '';
    request.on("data", function(chunk) { img = img + chunk; });
    request.on("end", function() {
      setUserURL(username, img);
      io.sockets.emit('frame', {username: username, state: getUserState(username), url: img});
			response.writeHead(201, {"Content-Type": "text/plain"});
			response.end("Saved Frame");
		});
	}
  else {
    serveFile(response, parsed_url.pathname);
  }
}

/////////////////////////////////////////////////////////////////////////
// Socket IO

io.sockets.on('connection', function (socket) {
	var username;

	socket.on('hello', function (data) {
		if( DEBUG ) { console.log('hello', data.username); }
		username = data.username;
		connectUser(username);
		socket.emit('welcome', {users: users});
		io.sockets.emit('join', {username: username, state: getUserState(username)});
	});

  socket.on('disconnect', function () {
		if( DEBUG ) { console.log('disconnect', username); }
		if( disconnectUser(username) ) {
			io.sockets.emit('quit', {username: username});
		}
  });

	socket.on('away', function () {
		markUserAway(username);
		io.sockets.emit('away', {username: username});
	});

	socket.on('return', function () {
		markUserAvailable(username);
		io.sockets.emit('return', {username: username});
	});

});

/////////////////////////////////////////////////////////////////////////
// Init or die!

fs.realpath('./htdocs', function (err, resolved_path) {
  if( err ) { throw err; }
  WEB_ROOT = resolved_path;
  http_server.listen(HTTPD_PORT);
});

setInterval(function () {
	var username,
	    removed_usernames = cleanUpStaleUsers();

	for( username in removed_usernames ) {
		if( removed_usernames.hasOwnProperty(username) ) {
			if( DEBUG ) { console.log('pruning dead client;', username); }
			io.sockets.emit('leave', {username: username});
		}
	}
	
}, REFRESH_INTERVAL);
