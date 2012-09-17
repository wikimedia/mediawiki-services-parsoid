#include <iostream>
#include <boost/checked_delete.hpp>
#include <boost/detail/atomic_count.hpp>

template<class T>
struct intrusive_ptr_base
{
    intrusive_ptr_base(): ref_count(0) 
    {
        #ifdef IP_DEBUG
        std::cout << "  Default constructor " << std::endl;
        #endif
    }
    //only construct an intrusive_ptr from another intrusive_ptr. That is it.
    intrusive_ptr_base(intrusive_ptr_base<T> const&)
        : ref_count(0) 
    {
        #ifdef IP_DEBUG
        std::cout << "  Copy constructor..." << std::endl;
        #endif
    }

    ///does nto support assignment
    intrusive_ptr_base& operator=(intrusive_ptr_base const& rhs)
    { 
        #ifdef IP_DEBUG
        std::cout << "  Assignment operator..." << std::endl;
        #endif
        return *this; 
    }

    friend void intrusive_ptr_add_ref(intrusive_ptr_base<T> const* s)
    {
        #ifdef IP_DEBUG
        std::cout << "  intrusive_ptr_add_ref..." << std::endl;
        #endif
        assert(s->ref_count >= 0);
        assert(s != 0);
        ++s->ref_count;
    }

    friend void intrusive_ptr_release(intrusive_ptr_base<T> const* s)
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

