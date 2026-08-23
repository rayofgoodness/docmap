<?php

namespace Vendor\ModuleTwo\Model;

use Magento\Framework\Event\ManagerInterface;

class EventDispatcher
{
    /**
     * @var ManagerInterface
     */
    private $eventManager;

    public function __construct(ManagerInterface $eventManager)
    {
        $this->eventManager = $eventManager;
    }

    public function execute(): void
    {
        $this->eventManager->dispatch('vendor_moduletwo_custom_event', ['dispatcher' => $this]);
    }
}
