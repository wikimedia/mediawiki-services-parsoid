#ifndef __MEDIAWIKI_API_H__
#define __MEDIAWIKI_API_H__

/**
 * Make callbacks into Mediawiki, usually the php process which
 * invoked this library.
 */
class MediawikiApi
{
public:
    string fetchArticle(string title);
};

#endif
