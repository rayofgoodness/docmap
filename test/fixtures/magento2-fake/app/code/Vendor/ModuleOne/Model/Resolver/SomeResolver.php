<?php

namespace Vendor\ModuleOne\Model\Resolver;

use Magento\Framework\GraphQl\Config\Element\Field;
use Magento\Framework\GraphQl\Query\ResolverInterface;

class SomeResolver implements ResolverInterface
{
    public function resolve(Field $field, $context, $info, array $value = null, array $args = null)
    {
        return ['id' => $args['id'] ?? null];
    }
}
