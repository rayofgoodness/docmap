<?php

namespace Vendor\ModuleOne\Observer;

use Magento\Framework\Event\ObserverInterface;
use Magento\Framework\Event\Observer as EventObserver;

class SomeObserver implements ObserverInterface
{
    public function execute(EventObserver $observer): void
    {
    }
}
