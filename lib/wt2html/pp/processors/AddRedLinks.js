/** @module */

'use strict';

const Promise = require('../../../utils/promise.js');

const { Batcher } = require('../../../mw/Batcher.js');

class AddRedLinks {
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

		const wikiLinks = Array.from(doc.body.querySelectorAll('a[rel~="mw:WikiLink"]'));

		const titleSet = wikiLinks.reduce(function(s, a) {
			// Magic links, at least, don't have titles
			if (a.hasAttribute('title')) { s.add(a.getAttribute('title')); }
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
			if (!a.hasAttribute('title')) { return; }
			const k = a.getAttribute('title');
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

	run(rootNode, env, options) {
		return AddRedLinks.addRedLinks(env, rootNode.ownerDocument);
	}
}

// This is clunky, but we don't have async/await until Node >= 7 (T206035)
AddRedLinks.addRedLinks = Promise.async(AddRedLinks.addRedLinksG);

module.exports.AddRedLinks = AddRedLinks;
