<?php

namespace Vendor\ModuleTwo\Controller\Index;

use Magento\Framework\App\Action\Action;

class Index extends Action
{
    public function execute()
    {
        return $this->_resultFactory->create();
    }
}
