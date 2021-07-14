<?php
# For the purpose of phan, we're always using IDLeDOM.  That avoids the
# type variance/co-variance issues involved in teaching phan about our
# DOM subclasses, and also keeps us from accessing any private implementation
# details of Dodo.

class_alias( "Wikimedia\\IDLeDOM\\Attr", "Wikimedia\\Parsoid\\DOM\\Attr" );
class_alias( "Wikimedia\\IDLeDOM\\CharacterData", "Wikimedia\\Parsoid\\DOM\\CharacterData" );
class_alias( "Wikimedia\\IDLeDOM\\Comment", "Wikimedia\\Parsoid\\DOM\\Comment" );
class_alias( "Wikimedia\\IDLeDOM\\Document", "Wikimedia\\Parsoid\\DOM\\Document" );
class_alias( "Wikimedia\\IDLeDOM\\DocumentFragment", "Wikimedia\\Parsoid\\DOM\\DocumentFragment" );
class_alias( "Wikimedia\\IDLeDOM\\DocumentType", "Wikimedia\\Parsoid\\DOM\\DocumentType" );
class_alias( "Wikimedia\\IDLeDOM\\DOMImplementation", "Wikimedia\\Parsoid\\DOM\\DOMImplementation" );
class_alias( "Wikimedia\\IDLeDOM\\Element", "Wikimedia\\Parsoid\\DOM\\Element" );
class_alias( "Wikimedia\\IDLeDOM\\Node", "Wikimedia\\Parsoid\\DOM\\Node" );
class_alias( "Wikimedia\\IDLeDOM\\NodeList", "Wikimedia\\Parsoid\\DOM\\NodeList" );
class_alias( "Wikimedia\\IDLeDOM\\ProcessingInstruction", "Wikimedia\\Parsoid\\DOM\\ProcessingInstruction" );
class_alias( "Wikimedia\\IDLeDOM\\Text", "Wikimedia\\Parsoid\\DOM\\Text" );

# Use Dodo versions of these classes which can be instantiated (otherwise
# phan will complain about our trying to instantiate an interface)
class_alias( "Wikimedia\\Dodo\\DOMParser", "Wikimedia\\Parsoid\\DOM\\DOMParser" );
class_alias( "Wikimedia\\Dodo\\DOMException", "Wikimedia\\Parsoid\\DOM\\DOMException" );
