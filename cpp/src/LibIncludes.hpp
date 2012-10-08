// General index header
//
#ifndef __HAVE_LIBINCLUDES__
#define __HAVE_LIBINCLUDES__

/**
 * Set up the general-purpose library environment, mainly STL and boost
 * libraries.
 */

#include <iostream>
#include <boost/checked_delete.hpp>
#include <boost/detail/atomic_count.hpp>
#include <boost/bind.hpp>
#include <boost/function.hpp>
#include <boost/intrusive_ptr.hpp>
#include <vector>
#include <deque>
#include <map>

typedef std::string string;
using std::vector;
using std::deque;
using boost::bind;
using boost::function;
using boost::intrusive_ptr;
using std::pair;
using std::map;

#endif // __HAVE_LIBINCLUDES__
