/**
 * These utilities are for processing content that's generated
 * by parsing source input (ex: wikitext)
 *
 * @module
 */

'use strict';

require('../../core-upgrade.js');

const Promise = require('./promise.js');
const XMLSerializer = require('../wt2html/XMLSerializer.js');
const { Batcher } = require('../mw/Batcher.js');
const { DOMDataUtils } = require('./DOMDataUtils.js');
const { DOMUtils } = require('./DOMUtils.js');
const { Util } = require('./Util.js');
const { WTUtils } = require('./WTUtils.js');

class ContentUtils {
	/**
	 * XML Serializer.
	 *
	 * @param {Node} node
	 * @param {Object} [options] XMLSerializer options.
	 * @return {string}
	 */
	static toXML(node, options) {
		return XMLSerializer.serialize(node, options).html;
	}

	/**
	 * .dataobject aware XML serializer, to be used in the DOM
	 * post-processing phase.
	 *
	 * @param {Node} node
	 * @param {Object} [options]
	 * @return {string}
	 */
	static ppToXML(node, options) {
		// We really only want to pass along `options.keepTmp`
		DOMUtils.visitDOM(node, DOMDataUtils.storeDataAttribs, options);
		return this.toXML(node, options);
	}

	/**
	 * .dataobject aware HTML parser, to be used in the DOM
	 * post-processing phase.
	 *
	 * @param {string} html
	 * @param {Object} [options]
	 * @return {Node}
	 */
	static ppToDOM(html, options) {
		options = options || {};
		var node = options.node;
		if (node === undefined) {
			node = DOMUtils.parseHTML(html).body;
		} else {
			node.innerHTML = html;
		}
		DOMUtils.visitDOM(node, DOMDataUtils.loadDataAttribs, options.markNew);
		return node;
	}

	/**
	 * Pull the data-parsoid script element out of the doc before serializing.
	 *
	 * @param {Node} node
	 * @param {Object} [options] XMLSerializer options.
	 * @return {string}
	 */
	static extractDpAndSerialize(node, options) {
		if (!options) { options = {}; }
		options.captureOffsets = true;
		var pb = DOMDataUtils.extractPageBundle(DOMUtils.isBody(node) ? node.ownerDocument : node);
		var out = XMLSerializer.serialize(node, options);
		// Add the wt offsets.
		Object.keys(out.offsets).forEach(function(key) {
			var dp = pb.parsoid.ids[key];
			console.assert(dp);
			if (Util.isValidDSR(dp.dsr)) {
				out.offsets[key].wt = dp.dsr.slice(0, 2);
			}
		});
		pb.parsoid.sectionOffsets = out.offsets;
		Object.assign(out, { pb: pb, offsets: undefined });
		return out;
	}

	static stripSectionTagsAndFallbackIds(node) {
		var n = node.firstChild;
		while (n) {
			var next = n.nextSibling;
			if (DOMUtils.isElt(n)) {
				// Recurse into subtree before stripping this
				this.stripSectionTagsAndFallbackIds(n);

				// Strip <section> tags
				if (WTUtils.isParsoidSectionTag(n)) {
					DOMUtils.migrateChildren(n, n.parentNode, n);
					n.parentNode.removeChild(n);
				}

				// Strip <span typeof='mw:FallbackId' ...></span>
				if (WTUtils.isFallbackIdSpan(n)) {
					n.parentNode.removeChild(n);
				}
			}
			n = next;
		}
	}

	/**
	 * Replace audio elements with videos, for backwards compatibility with
	 * content versions earlier than 2.x
	 */
	static replaceAudioWithVideo(doc) {
		Array.from(doc.querySelectorAll('audio')).forEach((audio) => {
			var video = doc.createElement('video');
			Array.from(audio.attributes).forEach(
				attr => video.setAttribute(attr.name, attr.value)
			);
			while (audio.firstChild) { video.appendChild(audio.firstChild); }
			audio.parentNode.replaceChild(video, audio);
		});
	}

	/**
	 * Dump the DOM with attributes.
	 *
	 * @param {Node} rootNode
	 * @param {string} title
	 * @param {Object} [options]
	 */
	static dumpDOM(rootNode, title, options) {
		let DiffUtils = null;
		options = options || {};
		if (options.storeDiffMark || options.dumpFragmentMap) { console.assert(options.env); }
		function cloneData(node, clone) {
			if (!DOMUtils.isElt(node)) { return; }
			var d = DOMDataUtils.getNodeData(node);
			DOMDataUtils.setNodeData(clone, Util.clone(d));
			if (options.storeDiffMark) {
				if (!DiffUtils) {
					DiffUtils = require('../html2wt/DiffUtils.js').DiffUtils;
				}
				DiffUtils.storeDiffMark(clone, options.env);
			}
			node = node.firstChild;
			clone = clone.firstChild;
			while (node) {
				cloneData(node, clone);
				node = node.nextSibling;
				clone = clone.nextSibling;
			}
		}

		function emit(buf, opts) {
			if (opts.outStream) {
				opts.outStream.write(buf.join('\n') + '\n');
			} else {
				console.warn(buf.join('\n'));
			}
		}

		// cloneNode doesn't clone data => walk DOM to clone it
		var clonedRoot = rootNode.cloneNode(true);
		cloneData(rootNode, clonedRoot);

		var buf = [];
		if (!options.quiet) {
			buf.push('----- ' + title + ' -----');
		}

		buf.push(ContentUtils.ppToXML(clonedRoot));
		emit(buf, options);

		// Dump cached fragments
		if (options.dumpFragmentMap) {
			Array.from(options.env.fragmentMap.keys()).forEach(function(k) {
				buf = [];
				buf.push('='.repeat(15));
				buf.push("FRAGMENT " + k);
				buf.push("");
				emit(buf, options);

				const newOpts = Object.assign({}, options, { dumpFragmentMap: false, quiet: true });
				const fragment = options.env.fragmentMap.get(k);
				ContentUtils.dumpDOM(Array.isArray(fragment) ? fragment[0] : fragment, '', newOpts);
			});
		}

		if (!options.quiet) {
			emit(['-'.repeat(title.length + 12)], options);
		}
	}

	/**
	 * Add red links to a document.
	 *
	 * @param {MWParserEnvironment} env
	 * @param {Document} doc
	 */
	static *addRedLinksG(env, doc) {
		/** @private */
		var processPage = function(page) {
			return {
				missing: page.missing !== undefined,
				known: page.known !== undefined,
				redirect: page.redirect !== undefined,
				disambiguation: page.pageprops &&
					page.pageprops.disambiguation !== undefined,
			};
		};

		const wikiLinks = doc.body.querySelectorAll('a[rel~="mw:WikiLink"]');

		const titleSet = wikiLinks.reduce(function(s, a) {
			const title = a.getAttribute('title');
			// Magic links, at least, don't have titles
			if (title !== null) { s.add(title); }
			return s;
		}, new Set());

		const titles = Array.from(titleSet.values());
		if (titles.length === 0) { return; }

		const titleMap = new Map();
		(yield Batcher.getPageProps(env, titles)).forEach(function(r) {
			Object.keys(r.batchResponse).forEach(function(t) {
				const o = r.batchResponse[t];
				titleMap.set(o.title, processPage(o));
			});
		});
		wikiLinks.forEach(function(a) {
			const k = a.getAttribute('title');
			if (k === null) { return; }
			let data = titleMap.get(k);
			if (data === undefined) {
				let err = true;
				// Unfortunately, normalization depends on db state for user
				// namespace aliases, depending on gender choices.  Workaround
				// it by trying them all.
				const title = env.makeTitleFromURLDecodedStr(k, undefined, true);
				if (title !== null) {
					const ns = title.getNamespace();
					if (ns.isUser() || ns.isUserTalk()) {
						const key = ':' + title._key.replace(/_/g, ' ');
						err = !(env.conf.wiki.siteInfo.namespacealiases || [])
							.some(function(a) {
								if (a.id === ns._id && titleMap.has(a['*'] + key)) {
									data = titleMap.get(a['*'] + key);
									return true;
								}
								return false;
							});
					}
				}
				if (err) {
					env.log('warn', 'We should have data for the title: ' + k);
					return;
				}
			}
			a.removeAttribute('class');  // Clear all
			if (data.missing && !data.known) {
				a.classList.add('new');
			}
			if (data.redirect) {
				a.classList.add('mw-redirect');
			}
			// Jforrester suggests that, "ideally this'd be a registry so that
			// extensions could, er, extend this functionality – this is an
			// API response/CSS class that is provided by the Disambigutation
			// extension."
			if (data.disambiguation) {
				a.classList.add('mw-disambig');
			}
		});
	}
}

// This is clunky, but we don't have async/await until Node >= 7 (T206035)
ContentUtils.addRedLinks = Promise.async(ContentUtils.addRedLinksG);

if (typeof module === "object") {
	module.exports.ContentUtils = ContentUtils;
}
