var myProductName = "nightlyRss", myVersion = "0.4.2";

var utils = require ("./lib/utils.js");
var dateFormat = require ("dateformat");
var filesystem = require ("./lib/filesystem.js");
var fs = require ("fs");
var request = require ("request");
var FeedParser = require ("feedparser");
var urlParser = require ("url");
var s3 = require ("./lib/s3.js");
var sendMail = require ("./lib/sendmail.js");


var emailTemplateFile = "emailtemplate.html", emailTemplate;

var stats = {
	ctPublishes: 0,
	whenLastPublish: new Date (0),
	ctSecsLastPublish: 0
	};
var fnameStats = "stats.json";
var flScheduledEveryMinute = false;
var flStatsDirty = false;
var fnameConfig = "config.json";
var config = {
	};

function formatDateTime (d) { 
	d = new Date (d);
	return (dateFormat (d, "m/d/yyyy; h:MM TT"));
	}
function getDomainFromUrl (url) {
	var parsedUrl = urlParser.parse (url);
	var s = parsedUrl.hostname;
	var ct = utils.stringCountFields (s, ".");
	if (ct >= 3) {
		s = utils.stringNthField (s, ".", ct - 1) + "." + utils.stringNthField (s, ".", ct);
		}
	return (s);
	}
function statsChanged () {
	flStatsDirty = true;
	}
function writeStats (f, stats) {
	filesystem.sureFilePath (f, function () {
		fs.writeFile (f, utils.jsonStringify (stats), function (err) {
			if (err) {
				console.log ("writeStats: error == " + err.message);
				}
			});
		});
	}
function readStats (f, stats, callback) {
	fs.exists (f, function (flExists) {
		if (flExists) {
			fs.readFile (f, function (err, data) {
				if (err) {
					console.log ("readStats: error reading file " + f + " == " + err.message)
					}
				else {
					var storedStats = JSON.parse (data.toString ());
					for (var x in storedStats) {
						stats [x] = storedStats [x];
						}
					writeStats (f, stats);
					}
				if (callback != undefined) {
					callback ();
					}
				});
			}
		else {
			writeStats (f, stats);
			if (callback != undefined) {
				callback ();
				}
			}
		});
	}

function readFeed (urlFeed, callback) {
	var itemarray = new Array ();
	var req = request (urlFeed);
	function feedError () {
		
		callback (undefined);
		}
	var feedparser = new FeedParser ();
	req.on ("response", function (res) {
		var stream = this;
		if (res.statusCode == 200) {
			stream.pipe (feedparser);
			}
		else {
			feedError ();
			}
		});
	req.on ("error", function (res) {
		feedError ();
		});
	feedparser.on ("readable", function () {
		try {
			var item = this.read ();
			itemarray [itemarray.length] = item;
			}
		catch (err) {
			console.log ("readFeed: parser error == " + err.message);
			}
		});
	feedparser.on ("error", function () {
		feedError ();
		});
	feedparser.on ("end", function () {
		callback (itemarray);
		});
	}
function buildNightlyFeed (theDay, callback) {
	var now = new Date ();
	
	theDay.setSeconds (0);
	theDay.setMinutes (0);
	theDay.setHours (0);
	
	readFeed (config.urlLinkblogFeed, function (itemarray) {
		var nowstring = formatDateTime (now), nowUtcString = now.toUTCString (), todaysText = "";
		var feedTitle, feedLink, feedDescription, feedDocs;
		var todaysPreText = utils.replaceAll (config.titleTemplate, "[date]", dateFormat (theDay, "m/d/yyyy"));
		
		for (var i = 0; i < itemarray.length; i++) {
			var item = itemarray [i];
			if (item != null) { //12/31/18 by DW
				if (utils.sameDay (theDay, item.pubDate)) {
					var link = "<a href=\"" + item.link + "\">" + getDomainFromUrl (item.link) + "</a>";
					if (todaysText.length > 0) {
						todaysText += "\n\n";
						}
					todaysText += "<p>" + item.description + " " + link + "</p>";
					feedTitle = item.meta.title;
					feedLink = item.meta.link;
					feedDescription = item.meta.description;
					feedDocs = item.meta.docs;
					}
				}
			}
		
		var xmltext = "", indentlevel = 0;
		//build xmltext
			function add (s) {
				xmltext += utils.filledString ("\t", indentlevel) + s + "\n";
				}
			function encode (s) {
				return (utils.encodeXml (s));
				}
			add ("<?xml version=\"1.0\"?>")
			add ("<!-- RSS generated by " + myProductName + " v" + myVersion + " on " + nowstring + " -->")
			add ("<rss version=\"2.0\">"); indentlevel++
			add ("<channel>"); indentlevel++;
			
			//header elements
				add ("<title>" + encode (feedTitle) + "</title>");
				add ("<link>" + encode (feedLink) + "</link>");
				add ("<description>" + encode (feedDescription) + "</description>");
				add ("<pubDate>" + theDay.toUTCString () + "</pubDate>"); 
				add ("<lastBuildDate>" + nowUtcString + "</lastBuildDate>");
				add ("<language>" + encode ("en-us") + "</language>");
				add ("<generator>" + encode (myProductName + " v" + myVersion) + "</generator>");
				if (feedDocs !== undefined) {
					add ("<docs>" + encode (feedDocs) + "</docs>");
					}
			//the item
				add ("<item>"); indentlevel++;
				add ("<title>" + encode ("Dave Winer's links for " + dateFormat (theDay, "m/d/yyyy")) + "</title>"); //10/3/16 by DW
				add ("<description>" + encode (todaysPreText + todaysText) + "</description>");
				add ("<guid isPermaLink=\"false\">" + encode (dateFormat (theDay, "m/d/yyyy")) + "</guid>");
				add ("<pubDate>" + theDay.toUTCString () + "</pubDate>"); 
				add ("<link>https://twitter.com/davewiner/status/773699254124765185</link>");  //ifttt requires a link element here?
				add ("</item>"); indentlevel--;
			
			add ("</channel>"); indentlevel--;
			add ("</rss>"); indentlevel--;
		
		s3.newObject (config.s3PathNightlyFeed, xmltext, "text/xml");
		
		stats.whenLastPublish = now;
		stats.ctPublishes++;
		stats.ctSecsLastPublish = utils.secondsSince (now);
		statsChanged ();
		
		console.log ("RSS feed for " + dateFormat (theDay, "m/d/yyyy") + " has " + xmltext.length + " chars. It took " + stats.ctSecsLastPublish + " secs to build.");
		
		if (callback !== undefined) {
			callback (todaysText);
			}
		});
	}
function checkFeed () {
	var now = new Date ();
	if (!utils.sameDay (now, stats.whenLastPublish)) {
		var yesterday = utils.dateYesterday (now);
		buildNightlyFeed (yesterday, function (todaysText) {
			var todaysTitle = "Dave's linkblog for " + dateFormat (yesterday, "m/d/yyyy");
			var pagetable = {
				title: todaysTitle,
				bodytext: todaysText,
				slogan: utils.getRandomSnarkySlogan ()
				};
			var pagetext = utils.multipleReplaceAll (emailTemplate, pagetable, false, "[%", "%]");
			
			
			sendMail.send (config.emailSendTo, todaysTitle, pagetext, config.emailSendFrom, function () {
				});
			
			});
		}
	}
function everyMinute () {
	var now = new Date ();
	console.log ("\neveryMinute: " + now.toLocaleTimeString ());
	checkFeed ();
	}
function everySecond () {
	if (!flScheduledEveryMinute) { 
		if (new Date ().getSeconds () == 0) {
			setInterval (everyMinute, 60000); 
			flScheduledEveryMinute = true;
			everyMinute (); //it's the top of the minute, we have to do one now
			}
		}
	if (flStatsDirty) {
		flStatsDirty = false;
		writeStats (fnameStats, stats);
		}
	}
function startup () {
	console.log ("\n" + myProductName + " v" + myVersion + " launched at " + new Date ().toLocaleTimeString () + ".\n");
	fs.readFile (emailTemplateFile, function (err, data) {
		if (err) {
			console.log ("startup: error reading email template == " + err.message)
			}
		else {
			emailTemplate = data.toString ();
			}
		readStats (fnameStats, stats, function () {
			console.log ("startup: stats == " + utils.jsonStringify (stats));
			readStats (fnameConfig, config, function () {
				console.log ("startup: config == " + utils.jsonStringify (config));
				checkFeed ();
				setInterval (everySecond, 1000); 
				});
			});
		});
	}

console.log ("\n" + myProductName + " v" + myVersion + "\n");
startup ();
