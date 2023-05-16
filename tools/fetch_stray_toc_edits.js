'use strict';

require('../core-upgrade.js');
const Promise = require('../lib/utils/promise.js');
const ScriptUtils = require('./ScriptUtils.js').ScriptUtils;
const processRCForWikis = require('./RCUtils.js').RCUtils.processRCForWikis;
const wmfSiteMatrix = require('./data/wmf.sitematrix.json').sitematrix;

// This list of wikis and TOC magicword strings ar derived
// by processing the language files in
// $MW_CORE/languages/languages/messages/Messages*.php
const tocWikiMap = {
	'afwiki': [ '__IO__', '__TOC__' ],
	'arwiki': [ '__فهرس__', '__TOC__' ],
	'arzwiki': [ '__فهرس__', '__TOC__' ],
	'be_taraskwiki': [ '__ЗЬМЕСТ__', '__TOC__' ],
	'bgwiki': [ '__СЪДЪРЖАНИЕ__', '__TOC__' ],
	'bnwiki': [ '__বিষয়বস্তুর_ছক__', '__বিষয়বস্তুরছক__', '__বিষয়বস্তুর_টেবিল__', '__বিষয়বস্তুরটেবিল__', '__TOC__' ],
	'bswiki': [ '__SADRŽAJ__', '__TOC__' ],
	'cawiki': [ '__TAULA__', '__RESUM__', '__TDM__', '__TOC__' ],
	'cewiki': [ '__ЧУЛАЦАМ__', '__ЧУЛ__', '__ОГЛАВЛЕНИЕ__', '__ОГЛ__', '__TOC__' ],
	'cswiki': [ '__OBSAH__', '__TOC__' ],
	'dewiki': [ '__INHALTSVERZEICHNIS__', '__TOC__' ],
	'diqwiki': [ '__ESTEN__', '__TOC__' ],
	'elwiki': [ '__ΠΠ__', '__ΠΙΝΑΚΑΣΠΕΡΙΕΧΟΜΕΝΩΝ__', '__TOC__' ],
	'enwiki': [ '__TOC__' ],
	'eowiki': [ '__I__', '__T__', '__INDEKSO__', '__TOC__' ],
	'eswiki': [ '__TDC__', '__TOC__' ],
	'etwiki': [ '__SISUKORD__', '__TOC__' ],
	'fawiki': [ '__فهرست__', '__TOC__' ],
	'fiwiki': [ '__SISÄLLYSLUETTELO__', '__TOC__' ],
	'frwiki': [ '__SOMMAIRE__', '__TDM__', '__TOC__' ],
	'frpwiki': [ '__SOMÈRO__', '__TRÂBLA__', '__SOMMAIRE__', '__TDM__', '__TOC__' ],
	'gawiki': [ '__CÁ__', '__TOC__' ],
	'glwiki': [ '__ÍNDICE__', '__TDC__', '__SUMÁRIO__', '__SUMARIO__', '__TOC__' ],
	'hewiki': [ '__תוכן_עניינים__', '__תוכן__', '__TOC__' ],
	'hiwiki': [ '__अनुक्रम__', '__विषय_सूची__', '__TOC__' ],
	'hrwiki': [ '__SADRŽAJ__', '__TOC__' ],
	'huwiki': [ '__TARTALOMJEGYZÉK__', '__TJ__', '__TOC__' ],
	'hywiki': [ '__ԲՈՎ__', '__TOC__' ],
	'idwiki': [ '__DAFTARISI__', '__DASI__', '__TOC__' ],
	'jawiki': [ '__目次__', '＿＿目次＿＿', '__TOC__' ],
	'kk_arabwiki': [ '__مازمۇنى__', '__مزمن__', '__МАЗМҰНЫ__', '__МЗМН__', '__TOC__' ],
	'kk_cyrlwiki': [ '__МАЗМҰНЫ__', '__МЗМН__', '__TOC__' ],
	'kk_latnwiki': [ '__MAZMUNI__', '__MZMN__', '__МАЗМҰНЫ__', '__МЗМН__', '__TOC__' ],
	'kmwiki': [ '__មាតិកា__', '__បញ្ជីអត្ថបទ__', '__TOC__' ],
	'kowiki': [ '__목차__', '__TOC__' ],
	'kshwiki': [ '__ENHALLT__', '__INHALTSVERZEICHNIS__', '__TOC__' ],
	'ku_latnwiki': [ '_NAVEROK_', '__TOC__' ],
	'ltwiki': [ '__TURINYS__', '__TOC__' ],
	'mgwiki': [ '__LAHATRA__', '__LAHAT__', '__SOMMAIRE__', '__TDM__', '__TOC__' ],
	'mkwiki': [ '__СОДРЖИНА__', '__TOC__' ],
	'mlwiki': [ '__ഉള്ളടക്കം__', '__TOC__' ],
	'mrwiki': [ '__अनुक्रमणिका__', '__TOC__' ],
	'mtwiki': [ '__WERREJ__', '__TOC__' ],
	'mznwiki': [ '__فهرست__', '__TOC__' ],
	'nbwiki': [ '__INNHOLDSFORTEGNELSE__', '__TOC__' ],
	'nds_nlwiki': [ '__ONDERWARPEN__', '__INHOUD__', '__TOC__' ],
	'ndswiki': [ '__INHOLTVERTEKEN__', '__INHALTSVERZEICHNIS__', '__TOC__' ],
	'newiki': [ '__अनुक्रम__', '__विषय_सूची__', '__TOC__' ],
	'nlwiki': [ '__INHOUD__', '__TOC__' ],
	'nnwiki': [ '__INNHALDSLISTE__', '__INNHOLDSLISTE__', '__TOC__' ],
	'ocwiki': [ '__TAULA__', '__SOMARI__', '__TDM__', '__TOC__' ],
	'oswiki': [ '__СÆРТÆ__', '__ОГЛАВЛЕНИЕ__', '__ОГЛ__', '__TOC__' ],
	'plwiki': [ '__SPIS__', '__TOC__' ],
	'pswiki': [ '__نيوليک__', '__TOC__' ],
	'pt_brwiki': [ '__TDC__', '__SUMARIO__', '__SUMÁRIO__', '__TOC__' ],
	'ptwiki': [ '__TDC__', '__SUMÁRIO__', '__SUMARIO__', '__TOC__' ],
	'quwiki': [ '__YUYARINA__', '__TDC__', '__TOC__' ],
	'rowiki': [ '__CUPRINS__', '__TOC__' ],
	'ruwiki': [ '__ОГЛАВЛЕНИЕ__', '__ОГЛ__', '__TOC__' ],
	'sahwiki': [ '__ИҺИНЭЭҔИТЭ__', '__ИҺН__', '__TOC__' ],
	'sawiki': [ '__अनुक्रमणी__', '__विषयसूची__', '__TOC__' ],
	'sewiki': [ '__SISDOALLU__', ' __SIS__', '__TOC__' ],
	'sh_latnwiki': [ '__SADRŽAJ__', '__TOC__' ],
	'skwiki': [ '__OBSAH__', '__TOC__' ],
	'slwiki': [ '__POGLAVJE__', '__TOC__' ],
	'sqwiki': [ '__TP__', '__TOC__' ],
	'sr_ecwiki': [ '__САДРЖАЈ__', '__TOC__' ],
	'sr_elwiki': [ '__SADRŽAJ__', '__TOC__' ],
	'srnwiki': [ '__INOT__', '__INHOUD__', '__TOC__' ],
	'svwiki': [ '__INNEHÅLLSFÖRTECKNING__', '__TOC__' ],
	'tewiki': [ '__విషయసూచిక__', '__TOC__' ],
	'tg_cyrlwiki': [ '__ФЕҲРИСТ__', '__TOC__' ],
	'tlywiki': [ '__MINDƏRİCOT__', '__TOC__' ],
	'trwiki': [ '__İÇİNDEKİLER__', '__TOC__' ],
	'tt_cyrlwiki': [ '__ЭЧТЕЛЕК__', '__ОГЛАВЛЕНИЕ__', '__ОГЛ__', '__TOC__' ],
	'tt_latnwiki': [ '__ET__', '__TOC__' ],
	'tyvwiki': [ '__ДОПЧУ__', '__ОГЛАВЛЕНИЕ__', '__ОГЛ__', '__TOC__' ],
	'ukwiki': [ '__ЗМІСТ__', '__ОГЛАВЛЕНИЕ__', '__ОГЛ__', '__TOC__' ],
	'urwiki': [ '__فہرست__', '__TOC__' ],
	'uzwiki': [ '__ICHIDAGILARI__', '__ICHIDAGILAR__', '__TOC__' ],
	'viwiki': [ '__MỤC_LỤC__', '__MỤCLỤC__', '__TOC__' ],
	'yiwiki': [ '__אינהאלט__', '__תוכן_עניינים__', '__תוכן__', '__TOC__' ],
	'zh_hanswiki': [ '__目录__', '__TOC__' ],
	'zh_hantwiki': [ '__目錄__', '__目录__', '__TOC__' ],
	'zhwiki': [  '__TOC__' ],
};

function arrayEquals(a, b) {
	return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
		a.every((val, index) => val === b[index]);
}

const fetchTOCMWs = async function(wiki) {
	const requestOpts = {
		method: 'GET',
		followRedirect: true,
		uri: wiki.url + '/w/api.php?action=query&meta=siteinfo&siprop=magicwords&format=json&formatversion=2',
		timeout: 5000 // 5 sec

	};
	const resp = await ScriptUtils.retryingHTTPRequest(3, requestOpts);
	const body = JSON.parse(resp[1]);
	let tocMws = null;
	body.query.magicwords.forEach(function(mw) {
		if (mw.name === 'toc') {
			tocMws = mw.aliases;
		}
	});

	wiki.toc = tocMws || [ "__TOC__" ]; // FIXME
};

const processDiff = Promise.async(function *(fetchArgs, diffUrl) {
	// Fetch the diff
	const requestOpts = {
		method: 'GET',
		followRedirect: true,
		uri: diffUrl,
		timeout: 5000 // 5 sec

	};
	const resp = yield ScriptUtils.retryingHTTPRequest(3, requestOpts);

	// Check if a new TOC magicword got introduced in the diff
	const tocMWs = fetchArgs.wiki.toc;
	const re = new RegExp(tocMWs.join('|'), 'g');
	const matches = resp[1].match(re);
	const ret = matches && matches.length % 2 === 1;
	if (ret) {
		console.log("\nSTRAY TOC added in " + diffUrl);
	} else {
		process.stderr.write(".");
	}
	return ret;
});

// Process the site matrix
const defaultTocMW = [ '__TOC__' ];
const wikis = [];
Object.keys(wmfSiteMatrix).forEach(function(k) {
	const e = wmfSiteMatrix[k];

	for (const j in e.site) {
		const w = e.site[j];
		// skip closed or private wkis
		if (w.closed === undefined && w.private === undefined ) {
			wikis.push({ prefix: w.dbname, url: w.url });
		}
	}
});

// DiscussionTools
processRCForWikis(
	wikis,
	{
		rcstart: '2023-05-05T00:00:00Z',
		rcend: '2023-05-08T11:59:59Z',
		rctag: 'discussiontools-reply', // discussiontools
		rcnamespace: "*" // any namespace
	},
	{
		fileSuffix: '_dt_toc',
		processDiff: processDiff,
		fetchMWs: fetchTOCMWs
	}
);

// VisualEditor
processRCForWikis(
	wikis,
	{
		rcstart: '2023-05-05T00:00:00Z',
		rcend: '2023-05-08T11:59:59Z',
		rctag: 'visualeditor', // visualeditor
		rcnamespace: "*" // any namespace
	},
	{
		fileSuffix: '_ve_toc',
		processDiff: processDiff,
		fetchMWs: fetchTOCMWs
	}
);
