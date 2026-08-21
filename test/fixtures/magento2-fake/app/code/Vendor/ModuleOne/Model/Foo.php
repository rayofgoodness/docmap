<?php

namespace Vendor\ModuleOne\Model;

use Vendor\ModuleTwo\Api\FooInterface;

class Foo implements FooInterface
{
    public function getValue(): int
    {
        return 42;
    }
}
