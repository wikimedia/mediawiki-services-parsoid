#ifndef __HAVE_INTRUSIVEPTRBASE_HPP__
#define __HAVE_INTRUSIVEPTRBASE_HPP__

#include <iostream>
#include <boost/checked_delete.hpp>
#include <boost/detail/atomic_count.hpp>
#include <boost/intrusive_ptr.hpp>

using std::string;

template<class T>
struct IntrusivePtrBase
{
    IntrusivePtrBase(): ref_count(0)
    {
        #ifdef IP_DEBUG
        std::cout << "  Default constructor " << std::endl;
        #endif
    }
    //only construct an intrusive_ptr from another intrusive_ptr. That is it.
    IntrusivePtrBase(IntrusivePtrBase<T> const&)
        : ref_count(0)
    {
        #ifdef IP_DEBUG
        std::cout << "  Copy constructor..." << std::endl;
        #endif
    }

    ///does not support assignment
    IntrusivePtrBase& operator=(IntrusivePtrBase const& rhs)
    {
        #ifdef IP_DEBUG
        std::cout << "  Assignment operator..." << std::endl;
        #endif
        return *this;
    }

    friend void intrusive_ptr_add_ref(IntrusivePtrBase<T> const* s)
    {
        #ifdef IP_DEBUG
        std::cout << "  intrusive_ptr_add_ref..." << std::endl;
        #endif
        assert(s->ref_count >= 0);
        assert(s != 0);
        ++s->ref_count;
    }

    friend void intrusive_ptr_release(IntrusivePtrBase<T> const* s)
    {
        #ifdef IP_DEBUG
        std::cout << "  intrusive_ptr_release..." << std::endl;
        #endif
        assert(s->ref_count > 0);
        assert(s != 0);
        if (--s->ref_count == 0)
            boost::checked_delete(static_cast<T const*>(s));
    }

    boost::intrusive_ptr<T> self()
    {
        return boost::intrusive_ptr<T>((T*)this);
    }

    boost::intrusive_ptr<const T> self() const
    {
        return boost::intrusive_ptr<const T>((T const*)this);
    }

    int refcount() const
    {
        return ref_count;
    }


private:
    ///should be modifiable even from const intrusive_ptr objects
    mutable boost::detail::atomic_count ref_count;
};

#endif // __HAVE_INTRUSIVEPTRBASE_HPP__

