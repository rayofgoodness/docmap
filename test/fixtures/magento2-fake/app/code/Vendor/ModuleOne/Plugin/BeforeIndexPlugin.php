<?php

namespace Vendor\ModuleOne\Plugin;

use Vendor\ModuleTwo\Controller\Index\Index;

class BeforeIndexPlugin
{
    public function beforeExecute(Index $subject): void
    {
    }
}
