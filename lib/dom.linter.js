/*
* Dom pass that walks the dom tree and place a call to logger with Logtype 'lint/*' to log following scenarios.
*
* 1. Tree Builder Fixups
* 2. Fostered Content
* 3. Ignored table attributes
* 4. Mixed Templates
*/

"use strict";

var DU = require('./mediawiki.DOMUtils.js').DOMUtils,
    Consts = require('./mediawiki.wikitext.constants.js').WikitextConstants,
    Util = require('./mediawiki.Util.js').Util;

/*
* Log Transclusion with more than one parts
* Ex - {{table-start}}
*      {{cell|unused value|key=used value}}
*      |-
*      {{cell|unused value|key=used value}}
*      |-
*      |<math>1+1</math>
*      |}
* https://www.mediawiki.org/wiki/Parsoid/MediaWiki_DOM_spec#Transclusion_content
*/

function logTransclusions(env, c) {

    if (DU.getDataMw(c)) {
        var dmw = DU.getDataMw(c);
        if (dmw.parts) {
            var parts = dmw.parts;
            if (parts.length > 1) {
                var targets = [],
                    t = null;
                dmw.parts.forEach(function(a) {
                    if (a.template || a.extension) {
                        targets.push(JSON.stringify(a.template.target));
                    }
                });
                if (targets.length > 1) {
                    var dp = DU.getDataParsoid(c).dsr;
                    env.log("lint/Mixed-template", targets, dp);
                }
            }
        }
    }
    return;
}

/*
* Log Tree Builder Fixups logs those cases which are marked by MarkTreeBuilderFixup.js
* It handles following scenarios.
*
* 1. Unclosed End Tags
* 2. Unclosed Start Tags
* 3. Stripped Tags
*/
function logTreeBuilderFixup(env, c, dp) {

    var cNodeName = c.nodeName.toLowerCase();
    if (DU.hasNodeName(c, 'meta')) {
        var type = c.getAttribute('typeof');
        if (type === 'mw:Placeholder/StrippedTag') {
            env.log('lint/strippedTag', env.page.src, dp.dsr);
        }
    }

    if (!Util.isVoidElement(cNodeName) &&
        !dp.selfClose &&
        cNodeName !== 'tbody' &&
        DU.hasLiteralHTMLMarker(dp) &&
        dp.dsr)
    {
        if (dp.autoInsertedEnd === true && dp.dsr[2]>0) {
            env.log('lint/missing-end-tag',
                    env.page.src, dp.dsr,
                    'Add End Tag to Fix this');
        }

        if (dp.autoInsertedStart === true && dp.dsr[3]>0) {
            env.log('lint/missing-start-tag',
                    env.page.src, dp.dsr,
                    'Add Start Tag to Fix this');
        }
    }
}

/*
* Log Ignored Table Attributes.
* This handle cases like:
*
* {|
* |- foo
* | bar
* |}
*
* Here foo gets Ignored and is found in the data-parsoid of <tr> tags.
*/
function logIgnoredTableAttr(env, c, dp) {

    var dsr;
    if (DU.hasNodeName(c, "table")) {
        var fc = c.firstChild;
        while (fc) {
            if (DU.hasNodeName(fc,"tbody")) {
                var trfc = fc.firstChild;
                while (trfc) {
                    if (DU.hasNodeName(trfc, "tr")) {
                        dp = DU.getDataParsoid(trfc);
                        if (dp.sa) {
                            var wc = false;
                            // Discard attributes that are only whitespace and comments
                            for(var a in dp.sa){
                                var re = /^\s*$|\n[ \t]*<!--([^-]|-(?!->))*-->([ \t]|<!--([^-]|-(?!->))*-->)*\n/g;
                                if (a && dp.sa.a && (!re.test(a) || !re.test(dp.sa.a))) {
                                    wc = true;
                                }
                            }
                            if (wc) {
                                dsr = dp.dsr;
                                env.log("lint/ignored-table-attr", env.page.src, dsr);
                            }
                        }
                    }
                    trfc = trfc.nextSibling;
                }
            }
            fc = fc.nextSibling;
        }
    }
}

/*
* Log Fostered Content marked by markFosteredContent.js
* This will log cases like:
*
* {|
* foo
* |-
* | bar
* |}
*
* Here 'foo' gets fostered out.
*/
function logFosteredContent(env, c, dp, nextSibling){

    var dsr;
    var fosteredSRC = c.innerHTML;
    while (nextSibling && !DU.hasNodeName(nextSibling,'table')) {
        fosteredSRC += nextSibling.innerHTML;
        nextSibling = nextSibling.nextSibling;
    }

    dsr = DU.getDataParsoid(nextSibling).dsr;
    env.log('lint/fostered', fosteredSRC, dsr);

    return nextSibling;
}

function logWikitextFixups(node, env) {

    var c = node.firstChild;

    while (c) {

        var nextSibling = c.nextSibling;
        if (DU.isTplElementNode(env, c)) {

            // Log transclusions with more than one part
            logTransclusions(env, c);

            // Skip over encapsulated Content
            nextSibling = DU.skipOverEncapsulatedContent(c);

        } else if (DU.isElt(c)) {

            var dp = DU.getDataParsoid( c ),
                src = dp.src,
                dsr;

            // Log Tree Builder fixups
            logTreeBuilderFixup(env, c, dp);

            // Log Ignored Table Attributes
            logIgnoredTableAttr(env, c, dp);

            if (dp.fostered) {
                // Log Fostered content
                nextSibling = logFosteredContent(env, c, dp, nextSibling);
            } else if ( c.childNodes.length > 0 ) {
                // Process subtree
                logWikitextFixups(c, env);
            }
        }

        c = nextSibling;
    }
}

if (typeof module === "object") {
    module.exports.logWikitextFixups = logWikitextFixups;
}
